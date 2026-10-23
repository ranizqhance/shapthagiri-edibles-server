import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { fn, col, Op } from "sequelize";
import { Role, Permission, RolePermission, User } from "@/models";
import { Role as RoleEnum } from "@/common/enums/role.enum";
import { BadRequestException, NotFoundException, ForbiddenException, ConflictException } from "@/common/errors/http";
import { WILDCARD_PERMISSION } from "./rbac.catalog";
import { RbacCacheService } from "./rbac-cache.service";
import { RbacAuditService, AuditContext } from "./rbac-audit.service";
import { assertCanGrant } from "@/common/utils/permission.util";

/** The acting user, for grant checks; null for internal (non-request) callers. */
const actorOf = (ctx: AuditContext) => (ctx.actorPermissions === undefined ? null : { permissions: ctx.actorPermissions });

/** Permissions that must never be stripped from your OWN active role (anti-lockout). */
const SELF_LOCK_KEYS = ["roles.view", "roles.edit"];
/** Wildcard system roles whose permission set is immutable via the API. */
const WILDCARD_ROLE_KEYS = ["admin", "super_admin"];

@Injectable()
export class RbacService {
  constructor(
    @InjectModel(Role) private readonly roleModel: typeof Role,
    @InjectModel(Permission) private readonly permModel: typeof Permission,
    @InjectModel(RolePermission) private readonly rolePermModel: typeof RolePermission,
    @InjectModel(User) private readonly userModel: typeof User,
    private readonly cache: RbacCacheService,
    private readonly audit: RbacAuditService,
  ) {}

  // ───────────────────────────── Reads ─────────────────────────────

  /** The permission catalog, grouped by module (for the matrix UI). Excludes "*". */
  async listPermissions() {
    const perms = await this.permModel.findAll({
      where: { isActive: true, key: { [Op.ne]: WILDCARD_PERMISSION } },
      order: [["sortModule", "ASC"], ["sortAction", "ASC"]],
    });

    const modules: Record<string, any> = {};
    for (const p of perms) {
      if (!modules[p.module]) {
        modules[p.module] = {
          module: p.module,
          moduleLabel: p.moduleLabel,
          group: p.moduleGroup,
          permissions: [] as any[],
        };
      }
      modules[p.module].permissions.push({ key: p.key, action: p.action, label: p.label });
    }
    return Object.values(modules);
  }

  /** All roles with assigned-user and permission counts. */
  async listRoles() {
    const [roles, userAgg, permAgg] = await Promise.all([
      this.roleModel.findAll({ order: [["isSystem", "DESC"], ["name", "ASC"]] }),
      this.userModel.findAll({
        attributes: ["roleId", [fn("COUNT", col("id")), "c"]],
        where: { roleId: { [Op.ne]: null } as any },
        group: ["roleId"],
        raw: true,
      }) as any as Promise<Array<{ roleId: string; c: string }>>,
      this.rolePermModel.findAll({
        attributes: ["roleId", [fn("COUNT", col("permissionId")), "c"]],
        group: ["roleId"],
        raw: true,
      }) as any as Promise<Array<{ roleId: string; c: string }>>,
    ]);

    const users = new Map((await userAgg).map((r) => [r.roleId, Number(r.c)]));
    const permsCount = new Map((await permAgg).map((r) => [r.roleId, Number(r.c)]));

    return roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      isActive: r.isActive,
      userCount: users.get(r.id) ?? 0,
      permissionCount: permsCount.get(r.id) ?? 0,
    }));
  }

  /** One role with its permission keys. `isWildcard` = holds all-access. */
  async getRole(id: string) {
    const role = await this.roleModel.findByPk(id, {
      include: [{ model: this.permModel, through: { attributes: [] }, required: false }],
    });
    if (!role) throw new NotFoundException("NOT_FOUND", "Role not found");
    const keys = (role.permissions ?? []).map((p) => p.key);
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      isActive: role.isActive,
      isWildcard: keys.includes(WILDCARD_PERMISSION),
      permissions: keys.filter((k) => k !== WILDCARD_PERMISSION),
    };
  }

  // ──────────────────────────── Mutations ───────────────────────────

  async createRole(dto: { name: string; description?: string; permissions?: string[] }, ctx: AuditContext) {
    if (actorOf(ctx) && dto.permissions?.length) assertCanGrant(actorOf(ctx), dto.permissions);
    const key = await this.uniqueKey(dto.name);
    const role = await this.roleModel.create({
      key,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      isSystem: false,
      isActive: true,
    } as any);

    if (dto.permissions?.length) {
      const rows = await this.validateKeys(dto.permissions);
      await this.rolePermModel.bulkCreate(rows.map((p) => ({ roleId: role.id, permissionId: p.id })) as any);
    }

    const result = await this.getRole(role.id);
    await this.audit.record("role.created", "role", role.id, null, result, ctx);
    return result;
  }

  async updateRole(id: string, dto: { name?: string; description?: string; isActive?: boolean }, ctx: AuditContext) {
    const role = await this.roleModel.findByPk(id);
    if (!role) throw new NotFoundException("NOT_FOUND", "Role not found");

    const before = { name: role.name, description: role.description, isActive: role.isActive };
    const deactivating = dto.isActive === false && role.isActive === true;

    if (deactivating && WILDCARD_ROLE_KEYS.includes(role.key)) {
      throw new ForbiddenException("AUTH_FORBIDDEN", `The ${role.name} role cannot be deactivated.`);
    }
    if (deactivating && (await this.isActorsRole(ctx.actorId, id))) {
      throw new ForbiddenException("AUTH_FORBIDDEN", "You cannot deactivate your own role.");
    }
    if (deactivating && role.key === "super_admin") {
      await this.assertNotLastSuperAdmin(id);
    }

    if (dto.name !== undefined) role.name = dto.name.trim();
    if (dto.description !== undefined) role.description = dto.description?.trim() || null;
    const statusChanged = dto.isActive !== undefined && dto.isActive !== role.isActive;
    if (dto.isActive !== undefined) role.isActive = dto.isActive;
    await role.save();

    if (statusChanged) this.cache.invalidate(id); // active-state affects effective perms
    const after = { name: role.name, description: role.description, isActive: role.isActive };
    await this.audit.record(statusChanged ? "role.status_changed" : "role.updated", "role", id, before, after, ctx);
    return this.getRole(id);
  }

  async setRolePermissions(id: string, keys: string[], ctx: AuditContext) {
    const role = await this.roleModel.findByPk(id, {
      include: [{ model: this.permModel, through: { attributes: [] }, required: false }],
    });
    if (!role) throw new NotFoundException("NOT_FOUND", "Role not found");
    if (WILDCARD_ROLE_KEYS.includes(role.key)) {
      throw new ForbiddenException("AUTH_FORBIDDEN", `The ${role.name} role has full access and its permissions cannot be edited.`);
    }

    const requested = Array.from(new Set(keys.filter((k) => k && k !== WILDCARD_PERMISSION)));
    if (actorOf(ctx)) assertCanGrant(actorOf(ctx), requested);

    // Anti-lockout: don't let admins strip their own ability to manage roles.
    if (await this.isActorsRole(ctx.actorId, id)) {
      const missing = SELF_LOCK_KEYS.filter((k) => !requested.includes(k));
      if (missing.length) {
        throw new ForbiddenException("AUTH_FORBIDDEN", `You cannot remove ${missing.join(", ")} from your own role.`);
      }
    }

    const rows = await this.validateKeys(requested);
    const before = (role.permissions ?? []).map((p) => p.key).filter((k) => k !== WILDCARD_PERMISSION);

    await this.rolePermModel.destroy({ where: { roleId: id } });
    if (rows.length) await this.rolePermModel.bulkCreate(rows.map((p) => ({ roleId: id, permissionId: p.id })) as any);

    this.cache.invalidate(id);
    await this.audit.record("role.permissions_changed", "role", id, { permissions: before }, { permissions: requested }, ctx);
    return this.getRole(id);
  }

  async duplicateRole(id: string, dto: { name?: string }, ctx: AuditContext) {
    const source = await this.roleModel.findByPk(id, {
      include: [{ model: this.permModel, through: { attributes: [] }, required: false }],
    });
    if (!source) throw new NotFoundException("NOT_FOUND", "Role not found");
    // A copy grants everything the source does; same rule as granting directly.
    if (actorOf(ctx)) assertCanGrant(actorOf(ctx), (source.permissions ?? []).map((p) => p.key));

    const name = dto.name?.trim() || `${source.name} (Copy)`;
    const key = await this.uniqueKey(name);
    const clone = await this.roleModel.create({
      key,
      name,
      description: source.description,
      isSystem: false, // a copy is always a custom role
      isActive: true,
    } as any);

    const permIds = (source.permissions ?? []).map((p) => p.id);
    if (permIds.length) {
      await this.rolePermModel.bulkCreate(permIds.map((permissionId) => ({ roleId: clone.id, permissionId })) as any);
    }

    const result = await this.getRole(clone.id);
    await this.audit.record("role.duplicated", "role", clone.id, { from: source.id, name: source.name }, result, ctx);
    return result;
  }

  async deleteRole(id: string, ctx: AuditContext) {
    const role = await this.roleModel.findByPk(id);
    if (!role) throw new NotFoundException("NOT_FOUND", "Role not found");
    if (role.isSystem) throw new ForbiddenException("AUTH_FORBIDDEN", "System roles cannot be deleted.");

    const userCount = await this.userModel.count({ where: { roleId: id } });
    if (userCount > 0) {
      throw new ConflictException("CONFLICT", `This role is assigned to ${userCount} user(s). Reassign them before deleting.`, { userCount });
    }

    const before = { id: role.id, key: role.key, name: role.name };
    await this.rolePermModel.destroy({ where: { roleId: id } });
    await role.destroy();
    this.cache.invalidate(id);
    await this.audit.record("role.deleted", "role", id, before, null, ctx);
    return { deleted: true };
  }

  async assignUserRole(userId: string, roleId: string | null | undefined, ctx: AuditContext) {
    const user = await this.userModel.findByPk(userId, { include: [{ association: "rbacRole" }] });
    if (!user) throw new NotFoundException("NOT_FOUND", "User not found");

    const before = { roleId: user.roleId, role: user.role };

    // Nobody re-roles an account more privileged than themselves, or hands out
    // a role holding permissions they lack — assigning was checked, what was
    // assigned was not, so the permission to assign roles meant super_admin.
    const actor = actorOf(ctx);
    if (actor) {
      assertCanGrant(actor, (await this.cache.getPermissionsForUser(user)).permissions);
      if (roleId) assertCanGrant(actor, await this.cache.getPermissionsForRole(roleId));
    }

    if (!roleId) {
      // Revert to the legacy enum-derived role (the BeforeUpdate hook re-resolves it).
      if (before.role === RoleEnum.ADMIN || user.rbacRole?.key === "super_admin") await this.assertNotLastSuperAdmin(user.roleId!, userId);
      user.roleId = null;
      user.changed("roleId", true);
      await user.save();
      const after = { roleId: user.roleId, role: user.role };
      await this.audit.record("user.role_removed", "user", userId, before, after, ctx);
      return this.reloadUserRole(userId);
    }

    const role = await this.roleModel.findByPk(roleId);
    if (!role) throw new NotFoundException("NOT_FOUND", "Role not found");
    if (!role.isActive) throw new BadRequestException("BAD_REQUEST", "Cannot assign an inactive role.");

    // Moving the last super_admin off the role is blocked.
    if (user.rbacRole?.key === "super_admin" && role.key !== "super_admin") {
      await this.assertNotLastSuperAdmin(user.roleId!, userId);
    }

    user.roleId = role.id;
    // Keep the legacy enum in sync when the role maps to one (coarse cookie gate).
    if ((Object.values(RoleEnum) as string[]).includes(role.key)) user.role = role.key as RoleEnum;
    await user.save();

    await this.audit.record("user.role_assigned", "user", userId, before, { roleId: role.id, role: user.role, roleKey: role.key }, ctx);
    return this.reloadUserRole(userId);
  }

  // ───────────────────────────── Helpers ────────────────────────────

  private async reloadUserRole(userId: string) {
    const u = await this.userModel.findByPk(userId, { include: [{ association: "rbacRole" }] });
    return {
      id: u!.id,
      name: u!.name,
      email: u!.email,
      role: u!.role,
      roleId: u!.roleId,
      rbacRole: u!.rbacRole ? { id: u!.rbacRole.id, key: u!.rbacRole.key, name: u!.rbacRole.name } : null,
    };
  }

  private slugify(name: string): string {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "role";
  }

  private async uniqueKey(name: string): Promise<string> {
    const base = this.slugify(name);
    let key = base;
    let n = 2;
    // paranoid: check including soft-deleted to avoid unique-constraint clashes.
    while (await this.roleModel.findOne({ where: { key }, paranoid: false })) {
      key = `${base}_${n++}`.slice(0, 60);
    }
    return key;
  }

  /** Ensures all keys exist in the catalog; rejects unknown or wildcard keys. */
  private async validateKeys(keys: string[]): Promise<Array<{ id: string; key: string }>> {
    const unique = Array.from(new Set(keys));
    if (unique.includes(WILDCARD_PERMISSION)) {
      throw new BadRequestException("BAD_REQUEST", "The wildcard permission cannot be assigned to custom roles.");
    }
    if (!unique.length) return [];
    const rows = await this.permModel.findAll({ where: { key: { [Op.in]: unique }, isActive: true }, attributes: ["id", "key"] });
    if (rows.length !== unique.length) {
      const found = new Set(rows.map((r) => r.key));
      const missing = unique.filter((k) => !found.has(k));
      throw new BadRequestException("BAD_REQUEST", `Unknown permission key(s): ${missing.join(", ")}`);
    }
    return rows.map((r) => ({ id: r.id, key: r.key }));
  }

  private async isActorsRole(actorId: string, roleId: string): Promise<boolean> {
    if (!actorId) return false;
    const actor = await this.userModel.findByPk(actorId, { attributes: ["roleId"] });
    return actor?.roleId === roleId;
  }

  /** Blocks an action that would remove the last active super_admin user. */
  private async assertNotLastSuperAdmin(superAdminRoleId: string, excludeUserId?: string) {
    const superRole = await this.roleModel.findOne({ where: { key: "super_admin" }, attributes: ["id"] });
    if (!superRole || superRole.id !== superAdminRoleId) return;
    const where: any = { roleId: superRole.id, isActive: true };
    if (excludeUserId) where.id = { [Op.ne]: excludeUserId };
    const remaining = await this.userModel.count({ where });
    if (remaining === 0) {
      throw new ForbiddenException("AUTH_FORBIDDEN", "At least one active Super Admin must remain.");
    }
  }
}
