/**
 * One-off: replace the guessable password on accounts made by phone OTP.
 *
 * Until the fix in auth.service, a phone sign-up was given the password
 * `firebase_<uid>`, and when it had no real email it was also given the
 * synthetic email `<uid>@firebase.user` — so anyone who learned a uid could sign
 * in through the email/password form. New accounts get a random password; this
 * script fixes the ones that already exist.
 *
 * For every `…@firebase.user` account whose hash still matches its derived
 * password, it sets a random hash nobody is told, bumps tokenVersion and
 * revokes its refresh sessions — so a session someone may already have opened
 * with that password ends too. The customer just signs in with OTP again.
 *
 * Dry run by default; nothing is written without --apply. Prints counts and
 * short user-id prefixes only, never emails or hashes.
 *
 *   npm run build   # or run with ts-node like db:sync
 *   ts-node -r tsconfig-paths/register src/scripts/rerandomise-derived-passwords.ts           # dry run
 *   ts-node -r tsconfig-paths/register src/scripts/rerandomise-derived-passwords.ts --apply
 *
 * Accounts that registered with a typed email kept `firebase_<uid>` too, but
 * their uid is not stored anywhere, so they cannot be told apart from a real
 * password here. Exploiting them needs the Firebase uid, which the API never
 * returns for those accounts; reported as residual risk.
 */
import "reflect-metadata";
import * as crypto from "crypto";
import { QueryTypes } from "sequelize";
import { sequelize } from "@/config/database";
import { env } from "@/config/env";
import { logger } from "@/common/utils/logger";
import { comparePassword, hashPassword } from "@/common/utils/password.util";

const SUFFIX = "@firebase.user";

async function main() {
  const apply = process.argv.includes("--apply");
  logger.info(`Connecting to ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME} (${apply ? "APPLY" : "dry run"}) ...`);
  await sequelize.authenticate();

  const rows = await sequelize.query<{ id: string; email: string; passwordHash: string }>(
    `SELECT id, email, "passwordHash" FROM users WHERE email LIKE :pattern`,
    { replacements: { pattern: `%${SUFFIX}` }, type: QueryTypes.SELECT },
  );

  let derived = 0;
  for (const u of rows) {
    const uid = u.email.slice(0, -SUFFIX.length);
    if (!u.passwordHash || !(await comparePassword(`firebase_${uid}`, u.passwordHash))) continue;
    derived++;
    if (!apply) continue;

    await sequelize.transaction(async (t) => {
      const fresh = await hashPassword(crypto.randomBytes(32).toString("base64url"));
      await sequelize.query(
        `UPDATE users SET "passwordHash" = :fresh, "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now() WHERE id = :id`,
        { replacements: { fresh, id: u.id }, transaction: t },
      );
      await sequelize.query(
        `UPDATE user_sessions SET revoked = true, "updatedAt" = now() WHERE "userId" = :id AND revoked = false`,
        { replacements: { id: u.id }, transaction: t },
      );
    });
    logger.info(`re-randomised ${u.id.slice(0, 8)}…`);
  }

  logger.info(
    `${rows.length} synthetic-email account(s) checked; ${derived} still had the derived password` +
      (apply ? ` — all ${derived} re-randomised, sessions revoked.` : ". Dry run: nothing changed (pass --apply)."),
  );
  await sequelize.close();
}

main().catch((e) => {
  logger.error(`rerandomise failed: ${(e as Error).message}`);
  process.exit(1);
});
