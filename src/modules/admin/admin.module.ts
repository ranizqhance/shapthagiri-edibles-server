import { Body, Controller, Get, Module, Param, Patch, Post, Put, Query, Delete, Ip, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { Op, QueryTypes } from "sequelize";
import type { Response } from "express";
import { AuditLog, FeatureFlag, Setting, User, UserAddress, Order, DeliveryPartner, DeliveryZone, DeliveryPartnerDocument, Shop } from "@/models";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { Role } from "@/common/enums/role.enum";
import { Role as RbacRoleModel } from "@/models/role.model";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate } from "@/common/utils/crud.util";
import { recordAudit, normalizeIp } from "@/common/utils/audit.util";
import { hashPassword } from "@/common/utils/password.util";
import { buildDeliveryPartnerDefaults, createPartnerDocuments } from "@/common/utils/partner.util";
import { BadRequestException } from "@/common/errors/http";
import { Public } from "@/common/decorators/public.decorator";
import { PricingService } from "@/modules/orders/pricing.service";

/** Documents required to onboard a delivery partner via Invite Member. */
const REQUIRED_PARTNER_DOCS = ["gov_id", "driving_license", "rc", "insurance"];
/** Legacy enum values still backed by the DB `role` column. */
const ENUM_ROLE_VALUES = new Set<string>(Object.values(Role));
/**
 * The legacy enum bucket to store for an assigned RBAC role. System roles keep their
 * own key; a CUSTOM role (key not in the enum) is bucketed as SUPPORT so the DB enum
 * constraint is satisfied — authorization comes from `roleId`, not this column.
 */
const enumBucketFor = (roleKey: string): Role =>
  (ENUM_ROLE_VALUES.has(roleKey) ? (roleKey as Role) : Role.SUPPORT);
import { AdminCreateUserDto, FeatureFlagDto, SettingUpsertDto, UpdateRoleDto } from "@/common/dto/common.dto";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { NotificationEventType } from "@/common/enums/notification-event.enum";

@ApiTags("Admin")
@ApiBearerAuth()
@RequirePermissions('users.view')
@Controller("admin")
export class AdminController {
  constructor(
    @InjectModel(DeliveryPartner) private partner: typeof DeliveryPartner,
    @InjectModel(DeliveryPartnerDocument) private doc: typeof DeliveryPartnerDocument,
    @InjectModel(DeliveryZone) private zone: typeof DeliveryZone,
    @InjectModel(User) private user: typeof User,
    @InjectModel(Shop) private shop: typeof Shop,
    @InjectModel(FeatureFlag) private flag: typeof FeatureFlag,
    @InjectModel(Setting) private setting: typeof Setting,
    @InjectModel(AuditLog) private audit: typeof AuditLog,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * The shopId to persist for a given role. A shop manager MUST be assigned to a
   * real shop (otherwise their account is un-scopable — every shop-scoped page
   * fails or hangs at login). Every other role carries no shop, so any stray
   * shopId is cleared. This is the single source of truth used by both create and
   * role-edit, so a manager can never be created/left without a valid shop.
   */
  private async resolveShopAssignment(role: string, shopId: string | null | undefined, t?: any): Promise<string | null> {
    if (role !== Role.SHOP_MANAGER) return null;
    if (!shopId) throw new BadRequestException("VALIDATION_FAILED", "A shop manager must be assigned to a shop.");
    const shop = await this.shop.findByPk(shopId, { transaction: t });
    if (!shop) throw new BadRequestException("VALIDATION_FAILED", "The selected shop was not found.");
    return shopId;
  }

  @Get("users") async users(@Query() opts: PageOptionsDto, @Query("role") role?: string, @Query("roleId") roleId?: string) {
    const where: any = {};
    // Prefer filtering by RBAC roleId (the Admin Users UI now filters on real roles,
    // incl. custom ones). `role` (legacy enum) kept for backward compatibility.
    if (roleId) where.roleId = roleId;
    else if (role) where.role = role;
    if (opts.q) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${opts.q}%` } },
        { email: { [Op.iLike]: `%${opts.q}%` } },
        { phone: { [Op.iLike]: `%${opts.q}%` } }
      ];
    }
    const result = await paginate(this.user, opts, where, [
      /*
       * Attribute-limited deliberately. Unqualified, these two includes pulled
       * every address and every complete order row — address snapshots,
       * totals, payment status — for up to 100 users in a single page.
       */
      { model: UserAddress, as: "addresses", attributes: ["id", "label", "city", "state", "postalCode", "isDefault"] },
      { model: Order, as: "orders", attributes: ["id", "orderNumber", "status", "total", "createdAt"] },
      // The assigned RBAC role — Admin Users displays this name, so a rename is
      // reflected everywhere immediately (single source of truth).
      { model: RbacRoleModel, as: "rbacRole", attributes: ["id", "name", "key", "isActive"] },
    ]);

    // Attach each delivery partner's operational lifecycle status so the Admin Users
    // list can show Pending/Approved/Suspended/Rejected instead of the account-level
    // "Active" badge. Account state (User.isActive) is unchanged for every role.
    const dpIds = result.items.filter((u: any) => u.role === Role.DELIVERY_PARTNER).map((u: any) => u.id);
    if (dpIds.length) {
      const partners = await this.partner.findAll({ where: { userId: dpIds }, attributes: ["userId", "status"] });
      const statusByUser = new Map(partners.map((p) => [p.userId, p.status]));
      result.items = result.items.map((u: any) => {
        const j = typeof u.toJSON === "function" ? u.toJSON() : u;
        if (j.role === Role.DELIVERY_PARTNER) j.deliveryStatus = statusByUser.get(j.id) ?? null;
        return j;
      });
    }
    return result;
  }

  @RequirePermissions('users.create')
  @Post("users") async createUser(@CurrentUser() actor: JwtPayload, @Ip() ip: string, @Body() b: AdminCreateUserDto) {
    const passwordHash = await hashPassword(b.password ?? "changeme");
    // Use a transaction to ensure both the user record and the partner profile are
    // created atomically. If partner creation fails the user insert is rolled back,
    // keeping the Admin Users and Delivery Partners modules in sync at all times.
    const sequelize = this.user.sequelize!;
    const created = await sequelize.transaction(async (t) => {
      // Strip delivery-only fields from the User insert (they belong on the partner).
      const { vehicle, vehicleNumber, city, zoneId, address, bankName, bankAccountNumber, bankIfscCode, documents, ...userFields } = b as any;
      // Enforce a valid shop for shop managers (and clear shopId for other roles)
      // BEFORE inserting — this is what prevents un-scopable manager accounts.
      // Structural branches key off `b.role` (the RBAC role's KEY: shop_manager /
      // delivery_partner), while the stored enum column is bucketed to a valid value
      // and `roleId` carries the real (possibly custom) RBAC role for permissions.
      const shopId = await this.resolveShopAssignment(b.role, (b as any).shopId, t);
      const user = await this.user.create(
        { ...userFields, role: enumBucketFor(b.role), roleId: b.roleId ?? undefined, shopId, passwordHash } as any,
        { transaction: t },
      );
      if (b.role === Role.DELIVERY_PARTNER) {
        // Zone is required for a delivery partner — verify it references a real zone.
        const zone = await this.zone.findByPk(zoneId, { transaction: t });
        if (!zone) throw new BadRequestException("VALIDATION_FAILED", "Selected delivery zone was not found");

        // All four onboarding documents are required at invite time.
        const providedTypes = new Set((documents ?? []).map((d: any) => d.type));
        const missingDocs = REQUIRED_PARTNER_DOCS.filter((dt: string) => !providedTypes.has(dt));
        if (missingDocs.length) throw new BadRequestException("VALIDATION_FAILED", `Missing required documents: ${missingDocs.join(", ")}`);

        // findOrCreate acts as a duplicate guard: if the endpoint is called twice
        // (e.g. due to a network retry) we do NOT create a second partner profile.
        // The UNIQUE constraint on delivery_partners.userId ensures DB-level safety.
        // Attributes come from the SHARED buildDeliveryPartnerDefaults helper so the
        // Invite and self-serve onboarding paths stay in lockstep. `city` defaults to
        // the assigned zone's label when the admin leaves it blank.
        const [partner] = await this.partner.findOrCreate({
          where: { userId: user.id },
          defaults: buildDeliveryPartnerDefaults({
            userId: user.id, name: b.name, phone: b.phone, avatarUrl: (b as any).avatarUrl,
            vehicle, vehicleNumber, address, city: city ?? zone.label, zoneId,
            bankName, bankAccountNumber, bankIfscCode,
          }) as any,
          transaction: t,
        });

        // Persist the uploaded documents as PENDING (admin verifies them later) —
        // shared with the self-serve onboarding path.
        await createPartnerDocuments(this.doc, partner.id, documents, t);
      }
      
      if (b.role === Role.SHOP_MANAGER) {
        this.eventEmitter.emit("admin.notify", {
          eventType: NotificationEventType.SHOP_MANAGER_CREATED,
          variables: { userId: user.id, email: user.email }
        });
      }
      
      return user;
    });

    await recordAudit(this.audit, {
      actorId: actor?.sub, action: "user_created", entity: "User", entityId: created.id,
      after: { name: created.name, email: created.email, role: created.role, shopId: created.shopId }, ip: normalizeIp(ip),
    });
    return created;
  }

  @RequirePermissions('users.editRole')
  @Patch("users/:id/role") async role(@CurrentUser() actor: JwtPayload, @Ip() ip: string, @Param("id") id: string, @Body() b: UpdateRoleDto) {
    const user = await this.user.findByPk(id);
    // Same guard as create: a shop manager must have a valid shop; other roles get null.
    const shopId = await this.resolveShopAssignment(b.role, b.shopId);
    // Resolve the RBAC role to persist. `.update()` is a bulk write and does NOT fire
    // the per-instance syncRbacRole hook, so set roleId explicitly here: use the one
    // the UI sent, else look it up from the enum bucket's key for the legacy path.
    let roleId = b.roleId;
    if (!roleId) {
      const r = await RbacRoleModel.findOne({ where: { key: enumBucketFor(b.role) }, attributes: ["id"] });
      roleId = r?.id;
    }
    await this.user.update({ role: enumBucketFor(b.role), roleId, shopId } as any, { where: { id } });

    await recordAudit(this.audit, {
      actorId: actor?.sub, action: "user_role_updated", entity: "User", entityId: id,
      before: { role: user?.role, shopId: user?.shopId }, after: { role: b.role, shopId }, ip: normalizeIp(ip),
    });

    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.USER_REGISTERED, // Using a fallback, or we can use generic Admin Role Changed
      variables: { userId: id, role: b.role, oldRole: user?.role }
    });

    return { updated: true };
  }

  @RequirePermissions('users.deactivate')
  @Post("users/:id/block") async blockUser(@CurrentUser() actor: JwtPayload, @Ip() ip: string, @Param("id") id: string) {
    const before = await this.user.findByPk(id);
    await this.user.update({ isActive: false } as any, { where: { id } });
    await recordAudit(this.audit, {
      actorId: actor?.sub, action: "user_blocked", entity: "User", entityId: id,
      before: { isActive: before?.isActive }, after: { isActive: false }, ip: normalizeIp(ip),
    });
    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.USER_BLOCKED,
      variables: { userId: id }
    });
    return { blocked: true };
  }

  @RequirePermissions('users.deactivate')
  @Delete("users/:id") async deleteUser(@CurrentUser() actor: JwtPayload, @Ip() ip: string, @Param("id") id: string) {
    const before = await this.user.findByPk(id);
    await this.user.destroy({ where: { id } });
    await recordAudit(this.audit, {
      actorId: actor?.sub, action: "user_deleted", entity: "User", entityId: id,
      before: before ? { name: before.name, email: before.email, role: before.role } : null, ip: normalizeIp(ip),
    });
    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.USER_DELETED,
      variables: { userId: id }
    });
    return { deleted: true };
  }

  @RequirePermissions('settings.view')
  @Get("feature-flags") flags() { return this.flag.findAll(); }
  @RequirePermissions('settings.edit')
  @Post("feature-flags") async setFlag(@CurrentUser() u: JwtPayload, @Ip() ip: string, @Body() b: FeatureFlagDto) {
    const before = await this.flag.findOne({ where: { key: b.key } });
    const [flag] = await this.flag.upsert(b as any);
    await recordAudit(this.audit, {
      actorId: u?.sub, action: "feature_flag_updated", entity: "FeatureFlag", entityId: b.key,
      before: before ? { enabled: before.enabled, rolloutPct: before.rolloutPct } : null,
      after: { enabled: flag.enabled, rolloutPct: flag.rolloutPct }, ip: normalizeIp(ip),
    });
    return flag;
  }
  @RequirePermissions('settings.view')
  @Get("settings") settings() { return this.setting.findAll(); }
  @RequirePermissions('settings.edit')
  @Put("settings/:key") async setKey(@CurrentUser() u: JwtPayload, @Ip() ip: string, @Param("key") key: string, @Body() b: SettingUpsertDto) {
    const before = await this.setting.findOne({ where: { key } });
    await this.setting.upsert({ key, value: b.value, scope: b.scope ?? null } as any);
    // Pricing caches settings for 30s; drop it so an edit here is visible on
    // the next checkout rather than up to half a minute later.
    PricingService.invalidateSettingsCache();
    await recordAudit(this.audit, {
      actorId: u?.sub, action: "setting_updated", entity: "Setting", entityId: key,
      before: before ? { value: before.value } : null, after: { value: b.value }, ip: normalizeIp(ip),
    });
    return { saved: true };
  }

  /**
   * Build the audit-log WHERE clause shared by the paginated list and the CSV
   * export, so both honour exactly the same filters. Supports actor, entity,
   * action, a free-text `q` (entityId / action / entity / correlationId), a
   * single `date`, and a `dateFrom`/`dateTo` range.
   */
  private buildAuditWhere(f: {
    actorId?: string; entity?: string; action?: string; q?: string;
    date?: string; dateFrom?: string; dateTo?: string;
  }): any {
    const where: any = {};
    if (f.actorId) where.actorId = f.actorId;
    if (f.entity) where.entity = f.entity;
    if (f.action) where.action = f.action;
    if (f.q) {
      const like = { [Op.iLike]: `%${f.q}%` };
      where[Op.or] = [{ entityId: like }, { action: like }, { entity: like }, { correlationId: like }];
    }
    // A single `date` is shorthand for that whole day; otherwise use the range.
    if (f.date) {
      const start = new Date(f.date); start.setHours(0, 0, 0, 0);
      const end = new Date(f.date); end.setHours(23, 59, 59, 999);
      where.createdAt = { [Op.between]: [start, end] };
    } else if (f.dateFrom || f.dateTo) {
      const range: any = {};
      if (f.dateFrom) { const s = new Date(f.dateFrom); s.setHours(0, 0, 0, 0); range[Op.gte] = s; }
      if (f.dateTo) { const e = new Date(f.dateTo); e.setHours(23, 59, 59, 999); range[Op.lte] = e; }
      where.createdAt = range;
    }
    return where;
  }

  @RequirePermissions('audit.view')
  @Get("audit-logs") logs(
    @Query() opts: PageOptionsDto,
    @Query("actorId") actorId?: string,
    @Query("entity") entity?: string,
    @Query("action") action?: string,
    @Query("date") date?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
  ) {
    // `q` and `order` live on PageOptionsDto. Actor is joined server-side so EVERY
    // actor resolves (customers included) — the UI no longer needs a staff lookup
    // that silently mislabels non-staff actors as "System".
    const where = this.buildAuditWhere({ actorId, entity, action, q: opts.q, date, dateFrom, dateTo });
    return paginate(this.audit, opts, where, [
      { model: User, as: "actor", attributes: ["id", "name", "email", "role"], required: false },
    ]);
  }

  /**
   * Distinct entities, actions and actors that actually appear in the log, so the
   * filter dropdowns reflect real data instead of a hardcoded guess.
   */
  @RequirePermissions('audit.view')
  @Get("audit-logs/facets") async auditFacets() {
    const seq = this.audit.sequelize!;
    const entities = await seq.query<{ entity: string }>(
      `SELECT DISTINCT entity FROM audit_logs ORDER BY entity`, { type: QueryTypes.SELECT });
    const actions = await seq.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs ORDER BY action`, { type: QueryTypes.SELECT });
    const actors = await seq.query<{ id: string; name: string; role: string }>(
      `SELECT DISTINCT u.id, u.name, u.role
         FROM audit_logs a JOIN users u ON u.id = a."actorId"
        WHERE a."actorId" IS NOT NULL
        ORDER BY u.name`, { type: QueryTypes.SELECT });
    return {
      entities: entities.map((e) => e.entity),
      actions: actions.map((a) => a.action),
      actors,
    };
  }

  /**
   * CSV export of the filtered audit trail. Bypasses the 100-row page cap (up to
   * 20k rows) so an operator can pull a complete slice for offline review. Written
   * straight to the response to skip the JSON envelope.
   */
  @RequirePermissions('audit.export')
  @Get("audit-logs/export") async auditExport(
    @Res() res: Response,
    @Query("actorId") actorId?: string,
    @Query("entity") entity?: string,
    @Query("action") action?: string,
    @Query("q") q?: string,
    @Query("date") date?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("order") order?: string,
  ) {
    const where = this.buildAuditWhere({ actorId, entity, action, q, date, dateFrom, dateTo });
    const rows = await this.audit.findAll({
      where,
      include: [{ model: User, as: "actor", attributes: ["id", "name", "email", "role"], required: false }],
      order: [["createdAt", order === "ASC" ? "ASC" : "DESC"]],
      limit: 20000,
    });

    const esc = (v: unknown) => {
      const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = ["Timestamp", "Actor", "Actor Role", "Action", "Entity", "Entity ID", "IP", "Correlation ID", "Before", "After"];
    const lines = [header.map(esc).join(",")];
    for (const r of rows as any[]) {
      lines.push([
        r.createdAt?.toISOString?.() ?? r.createdAt,
        r.actor?.name ?? "System",
        r.actor?.role ?? "",
        r.action, r.entity, r.entityId ?? "",
        r.ip ?? "", r.correlationId ?? "",
        r.before, r.after,
      ].map(esc).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join("\r\n"));
  }
}

/**
 * The handful of settings the storefront is allowed to read without signing in.
 *
 * A whitelist, deliberately, not a filter: the `settings` table is where future
 * gateway keys and internal thresholds will land, and a "return everything
 * except…" rule leaks each one the day it is added. Anything not named here
 * simply does not exist as far as this endpoint is concerned.
 */
const PUBLIC_SETTING_KEYS = ["business.whatsappNumber", "business.name", "business.phone"] as const;

@ApiTags("Settings")
@Controller("settings")
export class PublicSettingsController {
  constructor(@InjectModel(Setting) private setting: typeof Setting) {}

  /**
   * Cash-on-delivery hands the order to WhatsApp instead of creating one, so
   * the checkout — including for a signed-out visitor — has to know which
   * number to open. That is the reason this exists.
   */
  @Public()
  @Get("public")
  async publicSettings() {
    const rows = await this.setting.findAll({ where: { key: { [Op.in]: PUBLIC_SETTING_KEYS as unknown as string[] } } });
    const out: Record<string, unknown> = {};
    for (const key of PUBLIC_SETTING_KEYS) out[key] = rows.find((r) => r.key === key)?.value ?? null;
    return out;
  }
}

@Module({ imports: [SequelizeModule.forFeature([User, Shop, FeatureFlag, Setting, AuditLog, UserAddress, Order, DeliveryPartner, DeliveryZone, DeliveryPartnerDocument])], controllers: [AdminController, PublicSettingsController] })
export class AdminModule {}
