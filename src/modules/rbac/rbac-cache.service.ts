import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Role, Permission, User } from "@/models";
import { WILDCARD_PERMISSION } from "./rbac.catalog";

interface CacheEntry { perms: string[]; at: number }

/**
 * Loads and caches a role's effective permission keys.
 *
 * Called once per authenticated request (from JwtStrategy), so it must be cheap:
 * results are memoised per roleId with a short TTL, and invalidated explicitly
 * whenever a role's permissions/status change (Phase 3 mutations call
 * `invalidate`). This is what makes permission edits take effect on the user's
 * NEXT API call without a re-login and without a permission cookie.
 */
@Injectable()
export class RbacCacheService {
  private readonly cache = new Map<string, CacheEntry>();
  /** Safety net so a missed invalidation can never pin stale perms for long. */
  private readonly ttlMs = 30_000;

  constructor(
    @InjectModel(Role) private readonly roleModel: typeof Role,
    @InjectModel(Permission) private readonly permModel: typeof Permission,
    @InjectModel(User) private readonly userModel: typeof User,
  ) {}

  /** Effective permission keys for a role. Inactive role → no permissions. */
  async getPermissionsForRole(roleId: string): Promise<string[]> {
    const hit = this.cache.get(roleId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.perms;

    const role = await this.roleModel.findByPk(roleId, {
      include: [{ model: this.permModel, through: { attributes: [] }, required: false }],
    });
    const perms = role && role.isActive ? (role.permissions ?? []).map((p) => p.key) : [];
    this.cache.set(roleId, { perms, at: Date.now() });
    return perms;
  }

  /**
   * Effective permissions for a user. Prefers `roleId` (the RBAC source of truth);
   * falls back to resolving the legacy `role` enum by key during migration so a
   * user whose roleId was never backfilled still authorises correctly.
   */
  async getPermissionsForUser(user: Pick<User, "roleId" | "role">): Promise<{ roleId: string | null; permissions: string[] }> {
    let roleId = user.roleId ?? null;
    if (!roleId && user.role) {
      const role = await this.roleModel.findOne({ where: { key: String(user.role) }, attributes: ["id"] });
      roleId = role?.id ?? null;
    }
    const permissions = roleId ? await this.getPermissionsForRole(roleId) : [];
    return { roleId, permissions };
  }

  /** True if the permission set grants everything. */
  static hasWildcard(perms: string[]): boolean {
    return perms.includes(WILDCARD_PERMISSION);
  }

  /** Drop cached permissions for one role (or all). Call after any RBAC write. */
  invalidate(roleId?: string): void {
    if (roleId) this.cache.delete(roleId);
    else this.cache.clear();
  }
}
