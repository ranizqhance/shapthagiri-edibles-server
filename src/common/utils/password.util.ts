import bcrypt from "bcrypt";

/**
 * bcrypt work factor.
 *
 * Raised from 10 to 12. Each step doubles the work, so 12 is roughly 4x the
 * cost of 10 per hash — a few hundred milliseconds on this hardware, which a
 * person signing in will not notice but which makes an offline attack on a
 * stolen hash dump four times slower.
 *
 * Existing hashes keep working: bcrypt stores its cost in the hash itself, so
 * `compare` verifies old and new alike. They are re-hashed at 12 the next time
 * the password changes.
 */
const ROUNDS = 12;

export const hashPassword = (pw: string): Promise<string> => bcrypt.hash(pw, ROUNDS);
export const comparePassword = (pw: string, hash: string): Promise<boolean> => bcrypt.compare(pw, hash);
