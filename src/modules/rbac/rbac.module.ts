import { Global, Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { Role, Permission, RolePermission, User, AuditLog } from "@/models";
import { RbacCacheService } from "./rbac-cache.service";
import { RbacAuditService } from "./rbac-audit.service";
import { RbacService } from "./rbac.service";
import { RbacController } from "./rbac.controller";

/**
 * RBAC module. Global so the JwtStrategy and AuthService can inject
 * RbacCacheService to resolve permissions on every request.
 */
@Global()
@Module({
  imports: [SequelizeModule.forFeature([Role, Permission, RolePermission, User, AuditLog])],
  controllers: [RbacController],
  providers: [RbacCacheService, RbacAuditService, RbacService],
  exports: [RbacCacheService, RbacService],
})
export class RbacModule {}
