import { Sequelize } from "sequelize-typescript";
import { env, isProd } from "./env";
import { ALL_MODELS } from "@/models";
import { logger } from "@/common/utils/logger";

export const sequelize = new Sequelize({
  dialect: "postgres",
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  logging: env.DB_LOGGING ? (msg) => logger.debug(msg) : false,
  models: ALL_MODELS,
  pool: { max: 20, min: 2, acquire: 30000, idle: 10000 },
  define: { underscored: false, freezeTableName: true },
});

export async function connectDb(): Promise<void> {
  await sequelize.authenticate();
  logger.info("Database connection established");
  if (env.DB_AUTO_SYNC && !isProd) {
    await sequelize.sync({ alter: true });
    logger.info("Database auto-synced (alter mode)");
  }
}
