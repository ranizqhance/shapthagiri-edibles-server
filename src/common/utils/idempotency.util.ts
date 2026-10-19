import crypto from "node:crypto";
import { ConflictException } from "@/common/errors/http";

/**
 * Replay-safe execution keyed by a client-supplied Idempotency-Key.
 *
 * - No key  → runs `fn` directly (idempotency is opt-in via the header).
 * - First call for a key → runs `fn`, stores the response snapshot, returns it.
 * - Repeat call, same payload, completed → returns the stored snapshot (no re-run).
 * - Repeat call, *different* payload → IDEMPOTENCY_CONFLICT (409).
 *
 * `idemModel` is the Sequelize IdempotencyKey model (PK = key).
 */
export async function withIdempotency<T>(
  idemModel: any,
  params: { key?: string | null; endpoint: string; payload: unknown; ttlMs?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const { key, endpoint, payload, ttlMs = 24 * 3600_000 } = params;
  if (!key) return fn();

  const requestHash = crypto.createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex");
  const [row, created] = await idemModel.findOrCreate({
    where: { key },
    defaults: { key, endpoint, requestHash, responseSnapshot: null, expiresAt: new Date(Date.now() + ttlMs) },
  });

  if (!created) {
    if (row.requestHash !== requestHash) throw new ConflictException("IDEMPOTENCY_CONFLICT");
    if (row.responseSnapshot != null) return row.responseSnapshot as T;
    // Previous attempt never completed (in-flight/failed) — fall through and retry.
  }

  const result = await fn();
  await idemModel.update({ responseSnapshot: result as any }, { where: { key } });
  return result;
}
