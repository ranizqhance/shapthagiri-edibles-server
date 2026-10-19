import { randomBytes } from "node:crypto";
import { Op } from "sequelize";
import { Body, Controller, Get, Module, Param, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import {
  DeliveryAssignment, DeliveryEarning, DeliveryLocationPing, DeliveryPartner,
  DeliveryPartnerDocument, DeliveryPayout, FailedDelivery, Order, OrderShipment,
  OrderStatusHistory, User, UserAddress, Shop, OrderItem, EarningWallet, DeliveryZone, AuditLog
} from "@/models";
import { Public } from "@/common/decorators/public.decorator";
import { Roles } from "@/common/decorators/roles.decorator";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { Role } from "@/common/enums/role.enum";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate, findOr404 } from "@/common/utils/crud.util";
import { AssignmentExpiredException, NoPartnerAvailableException } from "@/common/errors/domain";
import { ForbiddenException, BadRequestException, NotFoundException } from "@/common/errors/http";
import { OrderStatus } from "@/common/enums/order-status.enum";
import { hashPassword } from "@/common/utils/password.util";
import { buildDeliveryPartnerDefaults, createPartnerDocuments } from "@/common/utils/partner.util";
import {
  DeliverDto, FailDto, PartnerDocumentDto, PartnerOnlineDto, PartnerPingDto, PartnerRegisterDto,
  PartnerOnboardDto, RejectPartnerDto, AssignZoneDto, BackgroundCheckDto, OrientationDto, VerifyPartnerDto,
} from "@/common/dto/common.dto";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { NotificationsService } from "@/modules/notifications/notifications.service";
import { pickPartner, candidateWhere } from "@/common/utils/partner-dispatch.util";

@ApiTags("Delivery Partners")
@Controller("partners")
export class PartnersController {
  constructor(
    @InjectModel(DeliveryPartner) private partner: typeof DeliveryPartner,
    @InjectModel(DeliveryPartnerDocument) private doc: typeof DeliveryPartnerDocument,
    @InjectModel(DeliveryAssignment) private assign: typeof DeliveryAssignment,
    @InjectModel(DeliveryLocationPing) private ping: typeof DeliveryLocationPing,
    @InjectModel(DeliveryEarning) private earning: typeof DeliveryEarning,
    @InjectModel(DeliveryPayout) private payout: typeof DeliveryPayout,
    @InjectModel(FailedDelivery) private failed: typeof FailedDelivery,
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(Order) private order: typeof Order,
    @InjectModel(OrderStatusHistory) private hist: typeof OrderStatusHistory,
    @InjectModel(OrderItem) private orderItem: typeof OrderItem,
    @InjectModel(EarningWallet) private wallet: typeof EarningWallet,
    @InjectModel(DeliveryZone) private zone: typeof DeliveryZone,
    @InjectModel(AuditLog) private audit: typeof AuditLog,
    @InjectModel(User) private user: typeof User,
    private notifications: NotificationsService,
  ) {}

  /** Audit + notify a partner on an admin lifecycle transition. */
  private async logTransition(actorId: string, partner: DeliveryPartner, action: string, before: any, after: any, notifyTitle?: string, notifyBody?: string) {
    await this.audit.create({ actorId, action, entity: "DeliveryPartner", entityId: partner.id, before, after } as any);
    if (notifyTitle && partner.userId) {
      await this.notifications.notify(partner.userId, notifyTitle, notifyBody ?? "", "all").catch(() => undefined);
    }
  }

  /** Required document types for a given vehicle. Bicycle needs only a government ID. */
  private requiredDocTypes(vehicle?: string): string[] {
    const base = ["gov_id"];
    if (vehicle && vehicle !== "Bicycle") base.push("driving_license", "rc", "insurance");
    return base;
  }

  /** Derived onboarding stage — a single source computed from status + checks (not stored). */
  private stageOf(p: DeliveryPartner, verifiedTypes: Set<string>): string {
    if (p.status === "rejected") return "rejected";
    if (p.status === "suspended") return "suspended";
    if (p.status === "approved") return "approved";
    const missingDocs = this.requiredDocTypes(p.vehicle).some((t) => !verifiedTypes.has(t));
    if (missingDocs) return "documents_pending";
    if (p.backgroundCheckStatus !== "passed") return "background_check";
    if (p.orientationStatus !== "completed") return "orientation";
    return "ready_for_approval";
  }

  /** Resolve the calling user's partner profile (every `me/*` + assignment action is scoped to it). */
  private async me(u: JwtPayload): Promise<DeliveryPartner> {
    const p = await this.partner.findOne({ where: { userId: u.sub } });
    if (!p) throw new NoPartnerAvailableException();
    return p;
  }

  /** Load an assignment and verify it belongs to the calling partner. */
  private async ownAssignment(u: JwtPayload, id: string): Promise<DeliveryAssignment> {
    const p = await this.me(u);
    const a = await findOr404<DeliveryAssignment>(this.assign, id, "Assignment");
    if (a.partnerId !== p.id) throw new ForbiddenException("AUTH_FORBIDDEN");
    return a;
  }

  /** Notify the order's customer about a shipment status change. */
  private async notifyCustomer(shipmentId: string, title: string, body: string) {
    const shipment = await this.ship.findByPk(shipmentId);
    if (!shipment) return;
    const order = await this.order.findByPk(shipment.orderId);
    if (order) await this.notifications.notify(order.userId, title, body, "all");
  }

  /**
   * Unauthenticated, so it is throttled hard: it inserts a row per call and
   * nothing downstream deduplicates. The sibling `onboard` route below was
   * already throttled; this one was missed.
   */
  @Public() @Throttle({ default: { ttl: 3_600_000, limit: 3 } })
  @Post("register") register(@Body() b: PartnerRegisterDto) { return this.partner.create(b as any); }

  /** Self-serve onboarding: creates the User (if absent) + a PENDING partner profile + documents, transactionally. */
  @Public() @Throttle({ default: { ttl: 60_000, limit: 5 } }) @Post("onboard") async onboard(@Body() b: PartnerOnboardDto) {
    const sequelize = this.partner.sequelize!;
    return sequelize.transaction(async (t) => {
      const email = b.email?.trim() || `${b.phone}@partners.local`;
      // Reuse an existing account by email if present, otherwise create one.
      let user = await this.user.findOne({ where: { email }, transaction: t });
      if (user) {
        /*
         * Do NOT silently attach a partner profile to an account found by
         * email. This route is public and takes the address from the request
         * body, so matching on it alone let anyone bolt a DELIVERY_PARTNER
         * profile onto a stranger's account by typing their address.
         */
        throw new BadRequestException(
          "CONFLICT",
          "An account already exists for this email. Sign in first, then apply to deliver.",
        );
      }
      /*
       * A random password, never the phone number.
       *
       * This used to be the last 8 digits of the number submitted in the same
       * request — a value the applicant publishes on their own parcels, and
       * one anybody can guess for a DELIVERY_PARTNER account, which can view
       * shipments and file proofs of delivery. Nobody is told this value; the
       * partner signs in with the OTP flow or a password reset.
       */
      const rawPassword = randomBytes(24).toString("base64url");
      user = await this.user.create({
        name: b.name, email, phone: b.phone, passwordHash: await hashPassword(rawPassword),
        role: Role.DELIVERY_PARTNER, isActive: true,
      } as any, { transaction: t });
      const existing = await this.partner.findOne({ where: { userId: user.id }, transaction: t });
      if (existing) throw new BadRequestException("CONFLICT", "A delivery partner profile already exists for this account");

      // Shared attribute builder (also used by AdminController.createUser) keeps the
      // two partner-creation paths and the `bank` JSONB shape identical.
      const partner = await this.partner.create(
        buildDeliveryPartnerDefaults({
          userId: user.id, name: b.name, phone: b.phone, avatarUrl: b.avatarUrl,
          vehicle: b.vehicle, vehicleNumber: b.vehicleNumber, address: b.address, city: b.city,
          licenseNumber: b.licenseNumber, bankAccountNumber: b.bankAccountNumber,
          bankIfscCode: b.bankIfscCode, bankName: b.bankName,
          emergencyContactName: b.emergencyContactName, emergencyContactPhone: b.emergencyContactPhone,
        }) as any,
        { transaction: t },
      );

      await createPartnerDocuments(this.doc, partner.id, b.documents, t);
      return partner;
    });
  }

  /**
   * KYC documents, scoped to the partner they belong to.
   *
   * Took any partner id from any authenticated account, so a customer could
   * write identity documents onto another person's partner profile — enough to
   * get a forged licence in front of whoever reviews them.
   */
  @ApiBearerAuth() @Post(":id/documents")
  async doc1(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: PartnerDocumentDto) {
    if (!(await this.ownsPartnerOrStaff(u, id))) throw new ForbiddenException("AUTH_FORBIDDEN");
    return this.doc.create({ partnerId: id, ...b } as any);
  }

  /** The partner themselves, or staff who administer partners. */
  private async ownsPartnerOrStaff(u: JwtPayload, partnerId: string): Promise<boolean> {
    if (u.permissions?.includes("*") || u.permissions?.includes("deliveryPartners.approve")) return true;
    const partner = await this.partner.findByPk(partnerId);
    return !!partner && partner.userId === u.sub;
  }

  @ApiBearerAuth() @RequirePermissions("deliveryPartners.approve") @Post("admin/:id/verify") async verify(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: VerifyPartnerDto) {
    const p = await this.partner.findByPk(id);
    if (!p) throw new NotFoundException("NOT_FOUND", "Partner not found");

    // Gate approval on verified required documents + background check + orientation, unless admin overrides.
    const docs = await this.doc.findAll({ where: { partnerId: id, status: "verified" } });
    const verifiedTypes = new Set(docs.map((d) => d.type));
    const missing = this.requiredDocTypes(p.vehicle).filter((tp) => !verifiedTypes.has(tp));
    if (p.backgroundCheckStatus !== "passed") missing.push("background_check");
    if (p.orientationStatus !== "completed") missing.push("orientation");
    if (missing.length && !b?.override) {
      throw new BadRequestException("VALIDATION_FAILED", `Cannot approve — outstanding: ${missing.join(", ")}. Send override:true to force-approve.`);
    }

    const before = { status: p.status };
    await p.update({ status: "approved", rejectionReason: null });
    await this.logTransition(u.sub, p, missing.length ? "verify_partner_override" : "verify_partner", before, { status: "approved" },
      "You're verified ✅", "Your delivery partner account has been approved. You can go online and start accepting jobs.");
    return { verified: true };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryPartners.approve") @Post("admin/:id/reject") async reject(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: RejectPartnerDto) {
    const p = await this.partner.findByPk(id);
    if (!p) throw new NotFoundException("NOT_FOUND", "Partner not found");
    const before = { status: p.status };
    await p.update({ status: "rejected", rejectionReason: b.reason });
    await this.logTransition(u.sub, p, "reject_partner", before, { status: "rejected", reason: b.reason },
      "Application update", `Your delivery partner application was not approved: ${b.reason}`);
    return { rejected: true };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryPartners.deactivate") @Post("admin/:id/suspend") async suspend(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: RejectPartnerDto) {
    const p = await this.partner.findByPk(id);
    if (!p) throw new NotFoundException("NOT_FOUND", "Partner not found");
    const before = { status: p.status };
    await p.update({ status: "suspended", isOnline: false, rejectionReason: b?.reason ?? null });
    await this.logTransition(u.sub, p, "suspend_partner", before, { status: "suspended", reason: b?.reason ?? null },
      "Account suspended", `Your delivery partner account has been suspended.${b?.reason ? " Reason: " + b.reason : ""}`);
    return { suspended: true };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryPartners.deactivate") @Post("admin/:id/reactivate") async reactivate(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const p = await this.partner.findByPk(id);
    if (!p) throw new NotFoundException("NOT_FOUND", "Partner not found");
    const before = { status: p.status };
    await p.update({ status: "approved", rejectionReason: null });
    await this.logTransition(u.sub, p, "reactivate_partner", before, { status: "approved" },
      "Account reactivated ✅", "Your delivery partner account has been reactivated. You can go online again.");
    return { reactivated: true };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryPartners.edit") @Post("admin/:id/background-check") async backgroundCheck(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: BackgroundCheckDto) {
    const p = await this.partner.findByPk(id);
    if (!p) throw new NotFoundException("NOT_FOUND", "Partner not found");
    const before = { backgroundCheckStatus: p.backgroundCheckStatus };
    await p.update({ backgroundCheckStatus: b.result });
    await this.logTransition(u.sub, p, "partner_background_check", before, { backgroundCheckStatus: b.result });
    return { backgroundCheckStatus: b.result };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryPartners.edit") @Post("admin/:id/orientation") async orientation(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: OrientationDto) {
    const p = await this.partner.findByPk(id);
    if (!p) throw new NotFoundException("NOT_FOUND", "Partner not found");
    const status = b.completed ? "completed" : "pending";
    const before = { orientationStatus: p.orientationStatus };
    await p.update({ orientationStatus: status });
    await this.logTransition(u.sub, p, "partner_orientation", before, { orientationStatus: status });
    return { orientationStatus: status };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryPartners.edit") @Post("admin/:id/assign-zone") async assignZone(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: AssignZoneDto) {
    const p = await this.partner.findByPk(id);
    if (!p) throw new NotFoundException("NOT_FOUND", "Partner not found");
    const zone = await this.zone.findByPk(b.zoneId);
    if (!zone) throw new NotFoundException("NOT_FOUND", "Zone not found");
    const before = { zoneId: p.zoneId };
    await p.update({ zoneId: b.zoneId, city: p.city ?? zone.label });
    await this.logTransition(u.sub, p, "assign_partner_zone", before, { zoneId: b.zoneId },
      "Zone assigned 📍", `You have been assigned to zone ${zone.label}.`);
    return { zoneId: b.zoneId };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryPartners.approve") @Post("admin/documents/:docId/verify") async verifyDoc(@CurrentUser() u: JwtPayload, @Param("docId") docId: string) {
    const d = await this.doc.findByPk(docId);
    if (!d) throw new NotFoundException("NOT_FOUND", "Document not found");
    await d.update({ status: "verified" });
    await this.audit.create({ actorId: u.sub, action: "verify_partner_document", entity: "DeliveryPartnerDocument", entityId: d.id, after: { status: "verified", type: d.type } } as any);
    return { status: "verified" };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryPartners.approve") @Post("admin/documents/:docId/reject") async rejectDoc(@CurrentUser() u: JwtPayload, @Param("docId") docId: string) {
    const d = await this.doc.findByPk(docId);
    if (!d) throw new NotFoundException("NOT_FOUND", "Document not found");
    await d.update({ status: "rejected" });
    await this.audit.create({ actorId: u.sub, action: "reject_partner_document", entity: "DeliveryPartnerDocument", entityId: d.id, after: { status: "rejected", type: d.type } } as any);
    return { status: "rejected" };
  }

  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Post("me/online") async online(@CurrentUser() u: JwtPayload, @Body() b: PartnerOnlineDto) {
    const p = await this.me(u);
    // Operational availability is gated on the lifecycle: only an approved partner may go online.
    if (b.online && p.status !== "approved") {
      throw new BadRequestException("VALIDATION_FAILED", "You can only go online once your account is approved.");
    }
    await p.update({ isOnline: b.online });
    return { online: b.online };
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Post("me/ping") async ping1(@CurrentUser() u: JwtPayload, @Body() b: PartnerPingDto) {
    const p = await this.me(u);
    await p.update({ currentLat: b.lat, currentLng: b.lng });
    await this.ping.create({ partnerId: p.id, lat: b.lat, lng: b.lng } as any);
    return { ok: true };
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Get("me/assignments") async myAssign(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    const p = await this.me(u);
    const where: any = { partnerId: p.id };
    if (opts.status) {
      where.status = opts.status;
    }
    return paginate(this.assign, opts, where, [
      {
        model: OrderShipment,
        as: "shipment",
        include: [
          { model: Shop, as: "shop" },
          { model: Order, as: "order", include: [{ model: User, as: "user" }] }
        ]
      }
    ]);
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Post("assignments/:id/accept") async accept(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const a = await this.ownAssignment(u, id);
    if (a.status !== "offered") throw new AssignmentExpiredException();
    await a.update({ status: "accepted", acceptedAt: new Date() }); return a;
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Post("assignments/:id/decline") async decline(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const a = await this.ownAssignment(u, id);
    await a.update({ status: "declined" });

    // A decline used to end here: the assignment went to "declined", the
    // shipment kept pointing at the partner who refused it, and nothing was
    // re-offered or raised. The job simply stopped moving, with no one aware.
    // Re-offer to the next best partner, skipping everyone already tried.
    const tried = (await this.assign.findAll({
      where: { shipmentId: a.shipmentId },
      attributes: ["partnerId"],
    })).map((x) => x.partnerId);

    const shipment = await this.ship.findByPk(a.shipmentId);
    const candidates = await this.partner.findAll({ where: candidateWhere(tried) });
    const next = pickPartner(candidates as any, {
      dropLat: shipment?.dropLat as any,
      dropLng: shipment?.dropLng as any,
      exclude: tried,
    });

    if (next) {
      await this.assign.create({
        shipmentId: a.shipmentId,
        partnerId: next.id,
        status: "offered",
        offeredAt: new Date(),
      } as any);
      await this.ship.update({ deliveryPartnerId: next.id }, { where: { id: a.shipmentId } });
      if (next.userId) {
        await this.notifications.notify(
          next.userId,
          "New delivery job 🛵",
          "A delivery assignment is available for pickup. Accept it before it expires.",
        );
      }
      return { declined: true, reoffered: true };
    }

    // Everyone available has already refused it. Hand it to ops rather than
    // leaving a shipment with a courier who is not coming.
    await this.ship.update({ deliveryPartnerId: null }, { where: { id: a.shipmentId } });
    if (shipment) {
      await this.notifications.notifyShopManagers(
        [shipment.shopId],
        "Delivery declined — no partner left ⚠️",
        `Shipment ${shipment.shipmentNumber} was declined and no other partner is available. Assign one manually.`,
      );
    }
    return { declined: true, reoffered: false };
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Post("assignments/:id/pickup") async pickup(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const a = await this.ownAssignment(u, id);
    await a.update({ status: "picked", pickedAt: new Date() });
    await this.ship.update({ status: OrderStatus.OUT_FOR_DELIVERY }, { where: { id: a.shipmentId } });
    const shipment = await this.ship.findByPk(a.shipmentId);
    if (shipment) {
      // Shipment-level + order-level history for complete audit trail
      // Single row with BOTH ids — see orders.module.ts: writing an order-level and
      // a shipment-level row for the same transition made the admin trail show it twice.
      await this.hist.create({ orderId: shipment.orderId, shipmentId: a.shipmentId, status: OrderStatus.OUT_FOR_DELIVERY, notes: `Shipment ${shipment.shipmentNumber} picked up — out for delivery`, actorId: u.sub } as any);
      await OrderShipment.deriveAndUpdateOrderStatus(shipment.orderId);
    }
    await this.notifyCustomer(a.shipmentId, "Out for delivery 🛵", "Your order is on its way!");
    return { picked: true };
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Post("assignments/:id/deliver") async deliver(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: DeliverDto) {
    const a = await this.ownAssignment(u, id);
    await a.update({ status: "delivered", deliveredAt: new Date() });
    await this.ship.update({ status: OrderStatus.DELIVERED, deliveredAt: new Date() }, { where: { id: a.shipmentId } });
    const shipment = await this.ship.findByPk(a.shipmentId);
    if (shipment) {
      // Shipment-level + order-level history
      await this.hist.create({ orderId: shipment.orderId, shipmentId: a.shipmentId, status: OrderStatus.DELIVERED, notes: `Shipment ${shipment.shipmentNumber} delivered`, actorId: u.sub } as any);
      await OrderShipment.deriveAndUpdateOrderStatus(shipment.orderId);

      // Shop Wallet Pending Earnings Update (idempotent per shipment — see EarningWallet.creditOnDelivery)
      const items = await this.orderItem.findAll({ where: { shipmentId: shipment.id } });
      const totalCost = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);

      await this.wallet.creditOnDelivery({
        shopId: shipment.shopId,
        orderId: shipment.orderId,
        amount: totalCost,
        referenceId: shipment.shipmentNumber,
      });
    }
    await this.earning.create({ partnerId: a.partnerId, assignmentId: a.id, amount: b.earnings ?? 50, type: "base" } as any);
    await this.notifyCustomer(a.shipmentId, "Delivered ✅", "Your order has been delivered. Enjoy — and please rate your experience!");
    return { delivered: true };
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Post("assignments/:id/fail") async fail(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: FailDto) {
    const a = await this.ownAssignment(u, id);
    await a.update({ status: "failed" });

    // Count previous attempts for this shipment to correctly increment attemptNo
    const previousAttempts = await this.failed.count({ where: { shipmentId: a.shipmentId } });
    const attemptNo = previousAttempts + 1;

    // Record the failed delivery with the correct attempt number and next retry window
    const nextAttemptAt = new Date(Date.now() + 2 * 3600_000); // retry in 2 hours
    await this.failed.create({
      shipmentId: a.shipmentId,
      attemptNo,
      reason: b.reason,
      nextAttemptAt,
    } as any);

    // Mark shipment as FAILED so deriveAndUpdateOrderStatus bubbles it up
    await this.ship.update({ status: OrderStatus.FAILED }, { where: { id: a.shipmentId } });
    const shipment = await this.ship.findByPk(a.shipmentId);
    if (shipment) {
      await this.hist.create({ orderId: shipment.orderId, shipmentId: a.shipmentId, status: OrderStatus.FAILED, notes: `Delivery attempt ${attemptNo} failed: ${b.reason} — retry at ${nextAttemptAt.toISOString()}`, actorId: u.sub } as any);
      await OrderShipment.deriveAndUpdateOrderStatus(shipment.orderId);
    }

    // Auto-reassign to the next available online partner (excluding the one who just failed)
    const nextPartner = await this.partner.findOne({
      where: { isOnline: true, status: "approved", id: { [Op.ne]: a.partnerId } },
    });
    if (nextPartner) {
      await this.assign.create({
        shipmentId: a.shipmentId,
        partnerId: nextPartner.id,
        status: "offered",
        offeredAt: new Date(),
      } as any);
      if (nextPartner.userId) {
        await this.notifications.notify(
          nextPartner.userId,
          "New delivery job 🛵",
          `A delivery assignment is available (attempt ${attemptNo + 1}). Accept it before it expires.`,
        );
      }
    }

    await this.notifyCustomer(a.shipmentId, "Delivery attempt failed", `We couldn't complete your delivery: ${b.reason}. We'll retry shortly.`);
    return { failed: true, attemptNo, nextAttemptAt };
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Get("me/earnings") async earn(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    const p = await this.me(u);
    return paginate(this.earning, opts, { partnerId: p.id });
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Get("me/payouts") async payouts(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    const p = await this.me(u);
    return paginate(this.payout, opts, { partnerId: p.id });
  }
  @ApiBearerAuth() @Roles(Role.DELIVERY_PARTNER) @Get("me/performance") async perf(@CurrentUser() u: JwtPayload) {
    const p = await this.me(u);
    const total = await this.assign.count({ where: { partnerId: p.id } });
    const delivered = await this.assign.count({ where: { partnerId: p.id, status: "delivered" } });
    const docs = await this.doc.findAll({ where: { partnerId: p.id } });
    const verifiedTypes = new Set(docs.filter((d) => d.status === "verified").map((d) => d.type));
    return {
      id: p.id,
      name: p.name,
      phone: p.phone,
      avatarUrl: p.avatarUrl,
      vehicle: p.vehicle,
      vehicleNumber: p.vehicleNumber,
      address: p.address,
      city: p.city,
      zoneId: p.zoneId,
      status: p.status,
      onboardingStage: this.stageOf(p, verifiedTypes),
      backgroundCheckStatus: p.backgroundCheckStatus,
      orientationStatus: p.orientationStatus,
      rejectionReason: p.rejectionReason,
      requiredDocuments: this.requiredDocTypes(p.vehicle),
      isOnline: p.isOnline,
      bank: p.bank,
      rating: p.rating,
      total,
      delivered,
      completionRate: total ? Math.round((delivered/total)*100) : 0,
      documents: docs
    };
  }
  @ApiBearerAuth() @RequirePermissions("deliveryPartners.view") @Get() all(
    @Query() opts: PageOptionsDto,
    @Query("status") status?: string,
    @Query("vehicle") vehicle?: string,
    @Query("city") city?: string,
    @Query("minRating") minRating?: string,
    @Query("search") search?: string,
    @Query("online") online?: string,
  ) {
    const where: any = {};
    if (status) where.status = status;                 // lifecycle: pending | approved | rejected | suspended
    if (vehicle) where.vehicle = vehicle;
    if (city) where.city = { [Op.iLike]: city };
    if (minRating) where.rating = { [Op.gte]: Number(minRating) };
    if (online === "true" || online === "false") where.isOnline = online === "true";
    if (search) where[Op.or] = [
      { name: { [Op.iLike]: `%${search}%` } },
      { phone: { [Op.iLike]: `%${search}%` } },
    ];
    return paginate(this.partner, opts, where, [
      { model: DeliveryEarning, as: "earnings" },
      { model: DeliveryZone, as: "zone" },
      { model: DeliveryPartnerDocument, as: "documents" },
      { model: User, as: "user", include: [{ model: UserAddress, as: "addresses" }] },
    ]);
  }
}

@Module({
  imports: [
    SequelizeModule.forFeature([
      DeliveryPartner, DeliveryPartnerDocument, DeliveryAssignment,
      DeliveryLocationPing, DeliveryEarning, DeliveryPayout, FailedDelivery,
      OrderShipment, Order, OrderStatusHistory, User, UserAddress, OrderItem, EarningWallet,
      DeliveryZone, AuditLog
    ]),
    NotificationsModule,
  ],
  controllers: [PartnersController],
})
export class PartnersModule {}
