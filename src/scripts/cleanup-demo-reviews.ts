/**
 * One-off: remove the demo reviews left over from testing.
 *
 * Every review on the test site was written by an `@example.com` account — the
 * demo customers and orders created while the store was being built — against
 * the per-pack demo products that were deleted when the catalog was rebuilt.
 * They can never appear on the website (their products are gone) and they are
 * not real customers' words, so publishing them anywhere would be fabricated
 * reviews. They only fill the dashboard queue and skew its numbers.
 *
 * Scope is deliberately narrow: reviews written by `@example.com` accounts,
 * plus their photos and helpful-votes. The demo accounts, their orders and
 * payments are not touched (removing those is a separate, larger decision).
 *
 * Dry run by default; nothing is written without --apply. Prints counts and
 * product titles only — never names, emails or review text.
 *
 *   npm run build
 *   node dist/scripts/cleanup-demo-reviews.js           # dry run: what would go
 *   node dist/scripts/cleanup-demo-reviews.js --apply   # delete, in one transaction
 *
 * Rows are hard-deleted (the reviews table is soft-delete by default, which
 * would leave them counted in the dashboard's totals query).
 */
import "reflect-metadata";
import { QueryTypes } from "sequelize";
import { sequelize } from "@/config/database";
import { env } from "@/config/env";
import { logger } from "@/common/utils/logger";

const DEMO_DOMAIN = "example.com";

const DEMO_REVIEWS = `
  SELECT r.id FROM product_reviews r
  JOIN users u ON u.id = r."userId"
  WHERE lower(split_part(u.email, '@', 2)) = :domain`;

async function main() {
  const apply = process.argv.includes("--apply");
  logger.info(`Connecting to ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME} (${apply ? "APPLY" : "dry run"}) ...`);
  await sequelize.authenticate();
  const replacements = { domain: DEMO_DOMAIN };

  const [totals] = await sequelize.query<{ all_reviews: number; demo: number; real: number }>(
    `SELECT count(*)::int all_reviews,
            count(*) FILTER (WHERE r.id IN (${DEMO_REVIEWS}))::int demo,
            count(*) FILTER (WHERE r.id NOT IN (${DEMO_REVIEWS}))::int real
       FROM product_reviews r`,
    { replacements, type: QueryTypes.SELECT },
  );
  const byStatus = await sequelize.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int n FROM product_reviews WHERE id IN (${DEMO_REVIEWS}) GROUP BY status ORDER BY 2 DESC`,
    { replacements, type: QueryTypes.SELECT },
  );
  const byProduct = await sequelize.query<{ title: string; deleted: boolean; n: number }>(
    `SELECT coalesce(p.title, '(unknown product)') title, (p."deletedAt" IS NOT NULL) deleted, count(*)::int n
       FROM product_reviews r
       LEFT JOIN product_variants v ON v.id = r."variantId"
       LEFT JOIN products p ON p.id = v."productId"
      WHERE r.id IN (${DEMO_REVIEWS})
      GROUP BY 1, 2 ORDER BY 3 DESC`,
    { replacements, type: QueryTypes.SELECT },
  );
  const [extras] = await sequelize.query<{ media: number; votes: number }>(
    `SELECT (SELECT count(*)::int FROM review_media WHERE "reviewId" IN (${DEMO_REVIEWS})) media,
            (SELECT count(*)::int FROM review_votes WHERE "reviewId" IN (${DEMO_REVIEWS})) votes`,
    { replacements, type: QueryTypes.SELECT },
  );

  logger.info(`Reviews in total: ${totals.all_reviews}. Demo (@${DEMO_DOMAIN}): ${totals.demo}. Kept (everyone else): ${totals.real}.`);
  logger.info(`Demo reviews by status: ${byStatus.map((s) => `${s.status} ${s.n}`).join(", ") || "none"}`);
  for (const p of byProduct) logger.info(`  ${p.n.toString().padStart(4)}  ${p.title}${p.deleted ? "  (product deleted)" : ""}`);
  logger.info(`Also removed with them: ${extras.media} photo(s), ${extras.votes} helpful-vote(s).`);

  if (!apply) {
    logger.info("Dry run — nothing changed. Re-run with --apply to delete exactly the rows counted above.");
    await sequelize.close();
    return;
  }

  await sequelize.transaction(async (t) => {
    await sequelize.query(`DELETE FROM review_media WHERE "reviewId" IN (${DEMO_REVIEWS})`, { replacements, transaction: t });
    await sequelize.query(`DELETE FROM review_votes WHERE "reviewId" IN (${DEMO_REVIEWS})`, { replacements, transaction: t });
    const [, meta]: any = await sequelize.query(`DELETE FROM product_reviews WHERE id IN (${DEMO_REVIEWS})`, { replacements, transaction: t });
    logger.info(`Deleted ${meta?.rowCount ?? "?"} demo review(s).`);
  });
  await sequelize.close();
}

main().catch(async (e) => {
  logger.error(`cleanup-demo-reviews failed: ${(e as Error).message}`);
  await sequelize.close().catch(() => undefined);
  process.exit(1);
});
