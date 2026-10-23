import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { AuditLog } from "@/models";

export interface AuditContext {
  actorId: string;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  /**
   * The acting user's own permission keys, for the rule that nobody may grant
   * what they do not hold. Set by every request-driven caller.
   */
  actorPermissions?: string[];
}

/** RBAC audit action names — every RBAC mutation maps to exactly one. */
export type RbacAuditAction =
  | "role.created"
  | "role.updated"
  | "role.deleted"
  | "role.duplicated"
  | "role.permissions_changed"
  | "role.status_changed"
  | "user.role_assigned"
  | "user.role_removed";

/**
 * Writes an immutable audit trail for every RBAC action. Nothing about roles or
 * permissions changes silently: who did it, when, the before/after snapshot, and
 * the originating IP + user-agent are all recorded via the existing audit_logs
 * table (surfaced in the Audit Trail UI).
 *
 * Audit writes never block the operation: a logging failure is swallowed (logged)
 * so an audit outage can't take down role management.
 */
@Injectable()
export class RbacAuditService {
  private readonly logger = new Logger(RbacAuditService.name);

  constructor(@InjectModel(AuditLog) private readonly auditModel: typeof AuditLog) {}

  async record(
    action: RbacAuditAction,
    entity: "role" | "user",
    entityId: string | null,
    before: unknown,
    after: unknown,
    ctx: AuditContext,
  ): Promise<void> {
    try {
      await this.auditModel.create({
        actorId: ctx.actorId ?? null,
        action,
        entity,
        entityId,
        before: before ?? null,
        after: after ?? null,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ? String(ctx.userAgent).slice(0, 300) : null,
        correlationId: ctx.correlationId ?? null,
      } as any);
    } catch (e: any) {
      this.logger.error(`Failed to write RBAC audit (${action}): ${e?.message}`);
    }
  }
}
