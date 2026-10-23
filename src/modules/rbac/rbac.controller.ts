import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { RbacService } from "./rbac.service";
import { AuditContext } from "./rbac-audit.service";
import { CreateRoleDto, UpdateRoleDto, SetRolePermissionsDto, DuplicateRoleDto, AssignRoleDto } from "./dto/rbac.dto";

/**
 * Roles & Permissions management. Every endpoint is permission-gated (403 when the
 * caller lacks the key) and every mutation is audited (who/when/old/new/ip/UA).
 */
@ApiTags("RBAC")
@ApiBearerAuth()
@Controller("rbac")
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  private ctx(user: JwtPayload, req: Request): AuditContext {
    const fwd = req.headers["x-forwarded-for"];
    return {
      actorId: user.sub,
      ip: req.ip ?? (Array.isArray(fwd) ? fwd[0] : fwd) ?? null,
      userAgent: (req.headers["user-agent"] as string) ?? null,
      correlationId: (req as any).correlationId ?? (req.headers["x-correlation-id"] as string) ?? null,
      actorPermissions: user.permissions ?? [],
    };
  }

  @Get("permissions")
  @RequirePermissions("roles.view")
  @ApiOperation({ summary: "Permission catalog grouped by module (for the matrix)" })
  listPermissions() {
    return this.rbac.listPermissions();
  }

  @Get("roles")
  @RequirePermissions("roles.view")
  @ApiOperation({ summary: "List roles with user/permission counts" })
  listRoles() {
    return this.rbac.listRoles();
  }

  @Get("roles/:id")
  @RequirePermissions("roles.view")
  @ApiOperation({ summary: "Role detail with its permission keys" })
  getRole(@Param("id") id: string) {
    return this.rbac.getRole(id);
  }

  @Post("roles")
  @RequirePermissions("roles.create")
  @ApiOperation({ summary: "Create a custom role" })
  createRole(@CurrentUser() u: JwtPayload, @Req() req: Request, @Body() dto: CreateRoleDto) {
    return this.rbac.createRole(dto, this.ctx(u, req));
  }

  @Patch("roles/:id")
  @RequirePermissions("roles.edit")
  @ApiOperation({ summary: "Update role name/description/status" })
  updateRole(@CurrentUser() u: JwtPayload, @Req() req: Request, @Param("id") id: string, @Body() dto: UpdateRoleDto) {
    return this.rbac.updateRole(id, dto, this.ctx(u, req));
  }

  @Put("roles/:id/permissions")
  @RequirePermissions("roles.edit")
  @ApiOperation({ summary: "Replace a role's permission set" })
  setPermissions(@CurrentUser() u: JwtPayload, @Req() req: Request, @Param("id") id: string, @Body() dto: SetRolePermissionsDto) {
    return this.rbac.setRolePermissions(id, dto.permissions, this.ctx(u, req));
  }

  @Post("roles/:id/duplicate")
  @RequirePermissions("roles.duplicate")
  @ApiOperation({ summary: "Duplicate a role (as a new custom role)" })
  duplicateRole(@CurrentUser() u: JwtPayload, @Req() req: Request, @Param("id") id: string, @Body() dto: DuplicateRoleDto) {
    return this.rbac.duplicateRole(id, dto, this.ctx(u, req));
  }

  @Delete("roles/:id")
  @RequirePermissions("roles.delete")
  @ApiOperation({ summary: "Delete a custom role (blocked if assigned or system)" })
  deleteRole(@CurrentUser() u: JwtPayload, @Req() req: Request, @Param("id") id: string) {
    return this.rbac.deleteRole(id, this.ctx(u, req));
  }

  @Post("users/:userId/assign-role")
  @RequirePermissions("roles.assignUsers")
  @ApiOperation({ summary: "Assign (or clear) a user's RBAC role" })
  assignRole(@CurrentUser() u: JwtPayload, @Req() req: Request, @Param("userId") userId: string, @Body() dto: AssignRoleDto) {
    return this.rbac.assignUserRole(userId, dto.roleId ?? null, this.ctx(u, req));
  }
}
