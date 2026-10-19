import { randomUUID } from "node:crypto";
import jwt, { SignOptions } from "jsonwebtoken";
import { env } from "@/config/env";
import { JwtPayload } from "@/modules/auth/jwt.strategy";

export const signAccess = (payload: JwtPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES } as SignOptions);

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
  jwt.sign({ ...payload, jti: randomUUID() }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES,
  } as SignOptions);

export const verifyRefresh = (token: string): JwtPayload =>
  jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload;
