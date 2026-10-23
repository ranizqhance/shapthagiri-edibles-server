import { randomUUID } from "node:crypto";
import jwt, { SignOptions } from "jsonwebtoken";
import { env } from "@/config/env";
import { JwtPayload } from "@/modules/auth/jwt.strategy";

/**
 * Every token carries a unique id and says what it is.
 *
 * `jti`: without it, two access tokens minted in the same second from the
 * same payload were byte-identical (iat is whole seconds) — two "sessions"
 * that were really one, which also merged their per-session rate limits.
 * `type`: an access token must never be accepted where a refresh token is
 * expected, or the reverse; separate secrets already ensure that in
 * production, and the claim keeps it true if they are ever shared.
 */
export const signAccess = (payload: JwtPayload): string =>
  jwt.sign({ ...payload, jti: randomUUID(), type: "access" }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES } as SignOptions);

/**
 * Sign a refresh token, with a unique id baked in.
 *
 * The `jti` is not decoration. `jwt.sign` stamps `iat` in whole seconds, so
 * signing the same payload twice inside one second produced two byte-identical
 * tokens — which silently defeated rotation: the "new" token hashed to the
 * same value as the one just marked spent, so the next refresh looked like
 * token reuse and signed the user out. A caught-by-test bug, not a theoretical
 * one.
 */
export const signRefresh = (payload: JwtPayload): string =>
  jwt.sign({ ...payload, jti: randomUUID(), type: "refresh" }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES,
  } as SignOptions);

export const verifyRefresh = (token: string): JwtPayload => {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload & { type?: string };
  // Tokens issued before the claim existed carry none; anything else must say "refresh".
  if (payload.type && payload.type !== "refresh") throw new Error("not a refresh token");
  return payload;
};
