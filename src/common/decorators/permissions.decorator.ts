import { SetMetadata } from "@nestjs/common";

export const PERMISSIONS_KEY = "permissions";
export const ANY_PERMISSIONS_KEY = "any_permissions";

/**
 * Require ALL listed permissions (AND). Attach to a handler or controller:
 *   @RequirePermissions("products.create")
 * The global PermissionsGuard reads this and 403s unless the user holds every key
 * (or the "*" wildcard). Permission keys are DB-defined (see rbac.catalog.ts) —
 * never invent keys not present in the catalog.
 */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** Require ANY ONE of the listed permissions (OR). */
export const RequireAnyPermission = (...permissions: string[]) => SetMetadata(ANY_PERMISSIONS_KEY, permissions);
