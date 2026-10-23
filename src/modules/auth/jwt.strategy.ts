import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, ExtractJwt } from "passport-jwt";
import { InjectModel } from "@nestjs/sequelize";
import { env } from "@/config/env";
import { Role } from "@/common/enums/role.enum";
import { User } from "@/models";
import { UnauthorizedException } from "@/common/errors/http";
import { RbacCacheService } from "@/modules/rbac/rbac-cache.service";

export interface JwtPayload {
  sub: string; role: Role; email: string; shopId?: string; tv?: number;
  /** RBAC role id (source of truth for authorization). */
  roleId?: string | null;
  /** Effective permission keys for this request. "*" = all-access. */
  permissions?: string[];
  /** Unique id, set on refresh tokens so each one is distinct. */
  jti?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectModel(User) private readonly userModel: typeof User,
    private readonly rbac: RbacCacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: env.JWT_ACCESS_SECRET,
    });
  }

  /**
   * Runs on every authenticated request. We do NOT trust the token's claims
   * blindly: we re-load the user so that role / shop / active-state changes and
   * token revocation (tokenVersion bump) take effect immediately rather than
   * waiting for the access token to expire.
   *
   * RBAC permissions are loaded here (cheap, cached) and attached to req.user so
   * the PermissionsGuard is a pure in-memory check and edits apply on the next call.
   */
  async validate(payload: JwtPayload): Promise<JwtPayload> {
    // Only access tokens here. Older tokens carry no type and are accepted
    // until they expire (15 minutes).
    if ((payload as any).type && (payload as any).type !== "access") throw new UnauthorizedException("AUTH_TOKEN_INVALID");
    const user = await this.userModel.findByPk(payload.sub);
    if (!user || !user.isActive) throw new UnauthorizedException("AUTH_TOKEN_INVALID");
    if ((payload.tv ?? 0) !== user.tokenVersion) throw new UnauthorizedException("AUTH_TOKEN_INVALID", "Session has been revoked");

    const { roleId, permissions } = await this.rbac.getPermissionsForUser(user);
    return {
      sub: user.id, role: user.role, email: user.email,
      shopId: user.shopId ?? undefined, tv: user.tokenVersion,
      roleId, permissions,
    };
  }
}
