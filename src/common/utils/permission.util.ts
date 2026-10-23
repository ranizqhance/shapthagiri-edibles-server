import { WILDCARD_PERMISSION } from "@/modules/rbac/rbac.catalog";
import { Role } from "@/common/enums/role.enum";
import { ForbiddenException } from "@/common/errors/http";

/**
 * Does the signed-in user hold any of these RBAC permissions (or the wildcard)?
 *
 * For checks inside a handler — "staff may act on anyone's record, everyone
 * else only on their own". Ask this instead of comparing `user.role` with
 * Role.CUSTOMER: that test let every other role (delivery partners, custom
 * roles stored as `support`) skip the ownership check entirely.
 *
 * `permissions` is loaded onto req.user by JwtStrategy on every request.
 */
export function hasPermission(user: { permissions?: string[] } | undefined | null, ...keys: string[]): boolean {
  const held = user?.permissions ?? [];
  return held.includes(WILDCARD_PERMISSION) || keys.some((k) => held.includes(k));
}

/**
 * The shop a shop-scoped staff account is confined to, or null for staff who
 * see the whole platform.
 *
 * A shop manager holds broad permission keys (orders.*, fulfillment.*,
 * finance.view …) because they run a shop — but every one of them means "for
 * my shop". Handlers that read or change data spanning shops must narrow to
 * this, or refuse; the permission check alone said yes to all shops' data.
 */
export function shopScope(user: { role?: string; shopId?: string | null } | undefined | null): string | null {
  if (user?.role !== Role.SHOP_MANAGER) return null;
  // A manager with no shop assigned is confined to nothing, not to everything.
  return user.shopId ?? "00000000-0000-0000-0000-000000000000";
}

/** Refuse a platform-wide view (P&L, tax, payouts …) to shop-scoped staff. */
export function assertPlatformScope(user: { role?: string; shopId?: string | null } | undefined | null): void {
  if (shopScope(user)) {
    throw new ForbiddenException("AUTH_FORBIDDEN", "This view covers the whole platform and is not available to shop accounts.");
  }
}

/**
 * Refuse to let an actor hand out permissions they do not hold themselves.
 *
 * Without this, anyone allowed to assign roles or edit a role's permissions
 * could make themselves (or a friend) super_admin: the permission to *assign*
 * was checked, never what was being assigned. The wildcard holder passes.
 */
export function assertCanGrant(actor: { permissions?: string[] } | undefined | null, granted: string[]): void {
  const held = actor?.permissions ?? [];
  if (held.includes(WILDCARD_PERMISSION)) return;
  const missing = granted.filter((p) => !held.includes(p));
  if (missing.length) {
    const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? "…" : "");
    throw new ForbiddenException("AUTH_FORBIDDEN", `You can only grant permissions you hold yourself (missing: ${shown}).`);
  }
}
