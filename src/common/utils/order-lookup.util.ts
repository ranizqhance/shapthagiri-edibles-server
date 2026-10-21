import * as crypto from "crypto";
import { env, isProd } from "@/config/env";
import { logger } from "@/common/utils/logger";

/**
 * Signed, expiring handles for guest order tracking.
 *
 * A customer who checked out with a phone OTP has an account but may never sign
 * back in, so their confirmation email carries a link that proves — on its own —
 * which order it refers to. The token is an HMAC over the order id and issue
 * time, so it cannot be forged or edited into a different order, and it expires
 * so a forwarded or leaked email does not grant access for ever.
 */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Returns null in production when unconfigured rather than throwing.
 *
 * Tracking links are generated from inside `t.afterCommit` on a placed order —
 * a throw there would take the customer's confirmation and the shop managers'
 * new-order notifications down with it, long after the order was committed. A
 * missing link is a small loss; a lost notification is not. Loud in the log,
 * harmless at runtime.
 *
 * Never falls back to another secret: whoever learned that one could then mint
 * tracking tokens for any order.
 */
function secret(): string | null {
  if (env.ORDER_LOOKUP_SECRET) return env.ORDER_LOOKUP_SECRET;
  if (isProd) {
    logger.error("ORDER_LOOKUP_SECRET is not set — order tracking links are disabled");
    return null;
  }
  return "dev-order-lookup-secret";
}

function sign(payload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * The storefront origin, taken from the first configured CORS origin — the same
 * derivation the password-reset email uses, so links in both land on the site
 * the browser actually loads.
 */
function webBase(): string {
  return (env.CORS_ORIGINS.split(",")[0] || "http://localhost:9164").trim().replace(/\/$/, "");
}

/** Full tracking URL for a confirmation email, or null when unconfigured. */
export function orderTrackingUrl(orderId: string): string | null {
  const token = createOrderLookupToken(orderId);
  return token ? `${webBase()}/track/${token}` : null;
}

/** Build the opaque token that goes in a tracking link, or null when unconfigured. */
export function createOrderLookupToken(orderId: string, issuedAt = Date.now()): string | null {
  const key = secret();
  if (!key) return null;
  const payload = `${orderId}.${issuedAt}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload, key)}`;
}

/**
 * Validate a token and return the order id it refers to, or null.
 *
 * Never throws on malformed input — a bad token and an expired one are the same
 * answer to the caller, so nothing can be learned by probing.
 */
export function readOrderLookupToken(token: string): string | null {
  try {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return null;

    const key = secret();
    if (!key) return null;

    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = sign(payload, key);
    // Constant-time: a length mismatch would otherwise leak through timingSafeEqual.
    if (expected.length !== signature.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

    const [orderId, issuedAtRaw] = payload.split(".");
    const issuedAt = Number(issuedAtRaw);
    if (!orderId || !Number.isFinite(issuedAt)) return null;
    if (Date.now() - issuedAt > TOKEN_TTL_MS) return null;

    return orderId;
  } catch {
    return null;
  }
}
