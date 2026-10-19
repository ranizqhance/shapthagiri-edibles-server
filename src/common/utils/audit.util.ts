import type { AuditLog } from "@/models";

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  correlationId?: string | null;
}

/**
 * Write one audit_logs row. Auditing must NEVER break the business action that
 * triggered it, so any failure here is swallowed and logged, not thrown.
 *
 * Use for admin/catalog mutations that weren't previously recorded (settings,
 * feature flags, user administration, product catalog). Rich transactional
 * flows (orders, returns, payments, inventory, …) keep their own inline writes.
 */
export async function recordAudit(model: typeof AuditLog, entry: AuditEntry): Promise<void> {
  try {
    await model.create({
      actorId: entry.actorId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ip: entry.ip ?? null,
      correlationId: entry.correlationId ?? null,
    } as any);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[audit] failed to record", entry.action, entry.entity, (e as Error)?.message);
  }
}

/** Normalise Express's req.ip (often "::ffff:127.0.0.1" or a list) to a plain address. */
export function normalizeIp(ip?: string | null): string | null {
  if (!ip) return null;
  const first = ip.split(",")[0].trim();
  return first.replace(/^::ffff:/, "") || null;
}
