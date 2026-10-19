import Redis from "ioredis";
import { env } from "@/config/env";

/** The handful of Redis commands the app uses (cache, locks, idempotency, rate limits). */
export interface KvClient {
  get(key: string): Promise<string | null>;
  /** Supports the `"EX" | "PX", ttl` and `"NX"` modifiers, like Redis SET. */
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<string>;
}

/**
 * In-process stand-in used when REDIS_ENABLED=false (local development). Same
 * semantics as the Redis commands above, but scoped to this one process — no
 * cross-instance locking, and everything is lost on restart.
 */
export class MemoryKv implements KvClient {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  private entry(key: string) {
    const e = this.store.get(key);
    if (e?.expiresAt !== undefined && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string) {
    return this.entry(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]) {
    let expiresAt: number | undefined;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const flag = String(args[i]).toUpperCase();
      if (flag === "EX") expiresAt = Date.now() + Number(args[++i]) * 1000;
      else if (flag === "PX") expiresAt = Date.now() + Number(args[++i]);
      else if (flag === "NX") nx = true;
    }
    if (nx && this.entry(key)) return null;
    this.store.set(key, { value: String(value), expiresAt });
    return "OK";
  }

  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }

  async incr(key: string) {
    const e = this.entry(key);
    const next = (e ? parseInt(e.value, 10) || 0 : 0) + 1;
    this.store.set(key, { value: String(next), expiresAt: e?.expiresAt });
    return next;
  }

  async expire(key: string, seconds: number) {
    const e = this.entry(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ping() {
    return "PONG";
  }

  async quit() {
    this.store.clear();
    return "OK";
  }
}

/**
 * Connection options shared by every ioredis client and BullMQ queue.
 *
 * The timeouts are the point of this object. ioredis defaults to
 * `enableOfflineQueue: true`, which parks every command in memory while the
 * connection is down and replays it on reconnect — so an unreachable Redis
 * turns into a request that waits instead of a request that fails. Combined
 * with a long `maxRetriesPerRequest` that is a ten-second stall on anything
 * touching the cache, and with `maxRetriesPerRequest: null` (see the queue) it
 * is a stall with no end at all.
 *
 * A cache is an optimisation. When it is gone the right behaviour is to find
 * out immediately and carry on without it.
 */
export const REDIS_OPTIONS = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  /** Fail the command rather than hold it until Redis comes back. */
  enableOfflineQueue: false,
  /** Two tries, then surface the error to the caller. */
  maxRetriesPerRequest: 2,
  connectTimeout: 3000,
  /** Keep trying to reconnect in the background, but never for long between. */
  retryStrategy: (times: number) => Math.min(times * 200, 5000),
};

/** Redis when REDIS_ENABLED, otherwise the in-memory stand-in. */
export function createKvClient(onError?: (err: Error) => void): KvClient {
  if (!env.REDIS_ENABLED) return new MemoryKv();
  const client = new Redis(REDIS_OPTIONS);
  if (onError) client.on("error", onError);
  return client as unknown as KvClient;
}
