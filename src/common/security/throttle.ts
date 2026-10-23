import { createHash } from "crypto";
import type { ExecutionContext } from "@nestjs/common";

/*
 * Rate-limit vocabulary shared by app.module (the throttlers) and the
 * controllers (@Throttle profiles), so a limit is named once.
 *
 * Three buckets exist:
 *   - default / write — per client IP (app.module). IP is what a proxy gives
 *     us: `trust proxy` is 1 (Traefik, no CDN). Put a CDN in front and that
 *     must become 2, or clients can forge X-Forwarded-For and walk round every
 *     limit here.
 *   - identity — per account identifier (normalised email or phone) taken from
 *     the request body. An attacker spreading guesses over many IPs still hits
 *     one ceiling per account, and a shared mobile-carrier IP does not lock
 *     out unrelated customers.
 *   - user — per session (a hash of the bearer token), for expensive
 *     per-user work such as PDFs and exports. The throttler runs before
 *     authentication, so the verified user id is not known yet; hashing the
 *     token keys it to the session without trusting anything in it.
 *
 * `identity` and `user` only count on routes that opt in with @Throttle; every
 * other route skips them, so they cost nothing there.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The account a request is about: normalised email, else phone digits. */
export function identityOf(req: any): string | null {
  const b = req?.body ?? {};
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (email) return `e:${email}`;
  const phone = typeof b.phone === "string" ? b.phone.replace(/\D/g, "") : "";
  if (phone.length >= 8) return `p:${phone.slice(-10)}`;
  return null;
}

/** The session behind a request, as a hash of its bearer token (else its IP). */
export function sessionOf(req: any): string {
  const auth: string = req?.headers?.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token ? `s:${createHash("sha256").update(token).digest("hex").slice(0, 32)}` : `ip:${req?.ip ?? ""}`;
}

/** True when the handler (or its controller) set a limit for this throttler. */
export function optedIn(ctx: ExecutionContext, name: string): boolean {
  const key = `THROTTLER:LIMIT${name}`;
  return Reflect.getMetadata(key, ctx.getHandler()) !== undefined || Reflect.getMetadata(key, ctx.getClass()) !== undefined;
}

/** @Throttle profiles. Limits per the security brief; deviations say why. */
export const LIMITS = {
  /** Password login: 5 per 15 min per IP and per account. No lockout — only this. */
  login: { default: { limit: 5, ttl: 15 * MIN }, identity: { limit: 5, ttl: 15 * MIN } },
  /**
   * Sending a code or a reset link: 3 per hour per address. Per IP it is 10,
   * not 3: Indian mobile networks put thousands of customers behind one
   * carrier IP, and at checkout 3/hour/IP would refuse real buyers. The
   * per-address limit is what stops a mailbox or phone being flooded.
   */
  sendCode: { default: { limit: 10, ttl: HOUR }, identity: { limit: 3, ttl: HOUR } },
  /** Checking a code or token: 10 per 15 min per IP and per account. */
  verifyCode: { default: { limit: 10, ttl: 15 * MIN }, identity: { limit: 10, ttl: 15 * MIN } },
  /** Coupon / gift-card validation, apply and claim: 20 per hour. */
  voucher: { default: { limit: 20, ttl: HOUR } },
  /** PDFs and exports: 5 per minute per session. */
  export: { user: { limit: 5, ttl: MIN } },
  /** Search, suggestions and geocoding: 30 per minute. */
  search: { default: { limit: 30, ttl: MIN } },
} as const;
