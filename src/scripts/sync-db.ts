import "reflect-metadata";
import { sequelize } from "@/config/database";
import { env, isProd } from "@/config/env";
import { logger } from "@/common/utils/logger";

async function main() {
  const force = process.argv.includes("--force");
  const alter = process.argv.includes("--alter");
  const override = process.argv.includes("--i-know-what-im-doing");

  if (force && isProd && !override) {
    logger.error("Refusing to run --force in production. Pass --i-know-what-im-doing to override.");
    process.exit(1);
  }

  logger.info(`Connecting to ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME} ...`);
  await sequelize.authenticate();

  if (force) {
    logger.warn("Dropping and recreating ALL tables (--force)");
    await sequelize.sync({ force: true });
  } else if (alter) {
    logger.info("Altering tables to match models (--alter)");
    await sequelize.sync({ alter: true });
  } else {
    logger.info("Safe sync (no destructive changes)");
    await sequelize.sync();
  }

  logger.info("Sync complete");
  await sequelize.close();
  process.exit(0);
}

main().catch((e) => {
  logger.error("Sync failed", { error: e });
  process.exit(1);
});
