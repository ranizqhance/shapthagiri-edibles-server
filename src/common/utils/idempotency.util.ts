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
    // No snapshot yet. A recent row means the first request is still running —
    // falling through here used to run `fn` a second time, so two simultaneous
    // requests with one key created two orders. Wait for the first to finish
    // and answer with its result instead.
    const age = Date.now() - new Date(row.createdAt ?? 0).getTime();
    if (age < IN_FLIGHT_MS) {
      for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const fresh = await idemModel.findByPk(key);
        if (!fresh) break; // the first attempt failed and released the key — run it ourselves
        if (fresh.responseSnapshot != null) return fresh.responseSnapshot as T;
      }
      if (await idemModel.findByPk(key)) throw new ConflictException("IDEMPOTENCY_IN_PROGRESS");
      await idemModel.create({ key, endpoint, requestHash, responseSnapshot: null, expiresAt: new Date(Date.now() + ttlMs) });
    }
    // Otherwise the previous attempt died long ago — retry.
  }

  let result: T;
  try {
    result = await fn();
  } catch (e) {
    // Release the key so the client's retry runs instead of waiting on a dead attempt.
    await idemModel.destroy({ where: { key, responseSnapshot: null } }).catch(() => undefined);
    throw e;
  }
  await idemModel.update({ responseSnapshot: result as any }, { where: { key } });
  return result;
}

/** A key younger than this with no snapshot is treated as still running. */
const IN_FLIGHT_MS = 60_000;
/** How long a duplicate waits for the first request's result. */
const WAIT_MS = 15_000;
const POLL_MS = 150;
