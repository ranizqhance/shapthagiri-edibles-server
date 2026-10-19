import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSIONS_KEY, ANY_PERMISSIONS_KEY } from "@/common/decorators/permissions.decorator";
import { IS_PUBLIC_KEY } from "@/common/decorators/public.decorator";
import { WILDCARD_PERMISSION } from "@/modules/rbac/rbac.catalog";
import { ForbiddenException } from "@/common/errors/http";

/**
 * Enforces @RequirePermissions / @RequireAnyPermission. Runs globally after
 * JwtAuthGuard + RolesGuard. The permission set is attached to req.user by
 * JwtStrategy (loaded fresh from the DB each request), so this guard is pure and
 * cheap — no DB access here.
 *
 * A user holding the "*" wildcard (admin / super_admin) passes everything.
 * Any missing requirement → 403 (AUTH_FORBIDDEN), the platform's standard shape.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    // Public routes bypass auth entirely (JwtAuthGuard skips them), so req.user is
    // absent — a class-level @RequirePermissions must NOT apply to them.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const all = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    const any = this.reflector.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!all?.length && !any?.length) return true; // no permission metadata → not gated by RBAC

    const { user } = ctx.switchToHttp().getRequest();
    const held: string[] = user?.permissions ?? [];
    if (held.includes(WILDCARD_PERMISSION)) return true;

    const set = new Set(held);
    if (all?.length && !all.every((p) => set.has(p))) throw new ForbiddenException("AUTH_FORBIDDEN");
    if (any?.length && !any.some((p) => set.has(p))) throw new ForbiddenException("AUTH_FORBIDDEN");
    return true;
  }
}
