import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { env } from "./env";
import { ALL_MODELS } from "../models/index";

@Module({
  imports: [
    SequelizeModule.forRoot({
      dialect: "postgres",
      host: env.DB_HOST,
      port: env.DB_PORT,
      username: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      logging: env.DB_LOGGING,
      models: ALL_MODELS,
      autoLoadModels: false,
      // Honoured in every environment, not just development. This project has no
      // migrations, so a deployed instance has no other way to create its schema
      // and previously started against an empty database where every query failed
      // with `relation "..." does not exist`.
      //
      // Safe because it maps to a plain `sequelize.sync()` — CREATE TABLE IF NOT
      // EXISTS semantics. It never alters or drops an existing table; only the
      // `--force` / `--alter` paths in scripts/sync-db.ts do that, and --force is
      // still refused in production. Set DB_AUTO_SYNC=false once the schema is
      // established and managed elsewhere.
      //
      // NOTE: @nestjs/sequelize only honours `synchronize` when autoLoadModels is
      // true, so this flag alone creates nothing — the actual sync() for
      // DB_AUTO_SYNC runs in main.ts before app.listen().
      synchronize: env.DB_AUTO_SYNC,
      pool: { max: 20, min: 2, acquire: 30000, idle: 10000 },
      define: { underscored: false, freezeTableName: true },
    }),
  ],
})
export class DatabaseModule {}
