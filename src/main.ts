import "reflect-metadata";
import { timingSafeEqual } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger, BadRequestException } from "@nestjs/common";
import type { ValidationError } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import compression from "compression";
import { readFileSync } from "fs";
import type { Request, Response, NextFunction } from "express";
import { Sequelize } from "sequelize-typescript";
import { AppModule } from "./app.module";
import { env, isProd } from "./config/env";
import { BRAND } from "./common/brand";
import { expandCorsOrigins } from "./common/utils/cors-origins.util";
import { getFirebase } from "./config/firebase";
import { ZoneCacheService } from "./modules/delivery-engine/zone-cache.service";
import { RedisIoAdapter } from "./common/adapters/redis-io.adapter";
import { auditRouteGates, registerSelfServiceHandlers } from "./common/security/route-gates";

/**
 * class-validator errors -> [{ field, message }], keeping the dotted path for
 * nested objects and arrays (e.g. "items.0.qty") so a form can highlight the
 * exact input that failed.
 */
function flattenValidationErrors(errors: ValidationError[], parent = ""): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  for (const e of errors) {
    const path = parent ? `${parent}.${e.property}` : e.property;
    for (const message of Object.values(e.constraints ?? {})) out.push({ field: path, message });
    if (e.children?.length) out.push(...flattenValidationErrors(e.children, path));
  }
  return out;
}

/**
 * Keep the API alive through a failing background side effect.
 *
 * `firebase-admin` throws transport errors from inside an HTTP/2 session event
 * handler — outside any promise chain, so no `.catch()` on the call can see
 * them. A push that could not reach Google was therefore enough to take the
 * whole shop down. Notifications are the least important thing this process
 * does; they must never be able to stop it serving orders.
 *
 * Logged loudly rather than silently swallowed: these are bugs to fix, not
 * noise to hide.
 */
function installCrashGuards() {
  const log = new Logger("Process");
  process.on("unhandledRejection", (reason) => {
    log.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception (continuing): ${err?.stack || err}`);
  });
}

/**
 * Decide which browser origins the API answers.
 *
 * Two improvements over handing `enableCors` a bare array.
 *
 * First, `www.` is treated as the same site. Mapping a domain usually produces
 * both the apex and the `www` host, and configuring only one of them silently
 * breaks every call from the other: the browser blocks the request before it
 * is sent, so nothing reaches the API, nothing is logged, and the storefront
 * shows "Something went wrong" on sign-in, OTP and checkout alike. Accepting
 * the `www` counterpart of a configured origin cannot widen access to any
 * other registrable domain.
 *
 * Second, a rejected origin is logged — once per origin, so a hostile scanner
 * cannot flood the log. Before this an origin typo produced total, silent
 * failure on the storefront with no trace at this end.
 */
function buildCorsOriginCheck(configured: string) {
  const allowed = new Set(expandCorsOrigins(configured));

  const rejected = new Set<string>();
  const log = new Logger("Cors");
  log.log(`Allowed origins: ${[...allowed].join(", ")}`);

  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    // No Origin header at all: server-to-server, curl, health checks. Those are
    // not browser requests and CORS does not apply to them.
    if (!origin) return cb(null, true);
    if (allowed.has(origin.replace(/\/$/, ""))) return cb(null, true);
    // Logged once per origin — and the memory of which ones is bounded, since
    // the Origin header is whatever the caller sends.
    if (!rejected.has(origin) && rejected.size < 1_000) {
      rejected.add(origin);
      log.warn(`Blocked request from origin ${origin} — add it to CORS_ORIGINS if this is one of ours.`);
    }
    // `false`, not an Error: the browser gets a clean response without the
    // allow header, which is the correct refusal. Throwing would surface as a
    // 500 in the log for what is routine behaviour.
    return cb(null, false);
  };
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function bootstrap() {
  installCrashGuards();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // `debug` only outside production. Every debug line is a string
    // interpolation evaluated before the logger decides to drop it, and the
    // pricing path emits two of them per call.
    logger: process.env.NODE_ENV === "production"
      ? ["log", "error", "warn"]
      : ["log", "error", "warn", "debug"],
    // Keeps the unparsed request body around. The Razorpay webhook signs the
    // exact bytes it sent, and re-serialising the parsed JSON would reorder
    // keys and drop whitespace, breaking the HMAC.
    rawBody: true,
  });

  /*
   * Trust exactly one proxy hop — Dokploy's Traefik.
   *
   * Without this Express reports the proxy's address as `req.ip` for every
   * request, so the rate limiter put the entire internet into a single
   * bucket: useless as a per-client limit, and a self-inflicted outage the
   * moment legitimate traffic crossed the threshold.
   *
   * The number matters and must match the real hop count. Too high and a
   * client can spoof `X-Forwarded-For` to claim any address it likes and walk
   * straight past every limit below. If a CDN is ever put in front of
   * Traefik, this becomes 2.
   */
  app.set("trust proxy", 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  // Catalogue and order responses are large JSON with very high redundancy;
  // nothing was compressing them before.
  app.use(compression());
  app.enableCors({ origin: buildCorsOriginCheck(env.CORS_ORIGINS), credentials: true });
  app.setGlobalPrefix(env.API_PREFIX.replace(/^\//, ""));
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    // Keep the property name on each error. The default pipe flattens errors to
    // a plain string[], so the filter had nothing to attribute them to and
    // labelled every one `field: "body"` — which matches no form key, leaving
    // the inline field errors the forms already render permanently dead.
    exceptionFactory: (errors) => new BadRequestException(flattenValidationErrors(errors)),
  }));
  // No static /uploads route: user uploads live in S3 and are served from the
  // bucket, never from this process's filesystem.

  /*
   * HTTP Basic for the operator surfaces: the API docs and the Bull Board
   * queue dashboard.
   *
   * Bull Board matters more than it looks. It is mounted as Nest middleware
   * (notifications.module.ts), and guards only run on controller routes — so
   * JwtAuthGuard, RolesGuard and PermissionsGuard never execute for it. Anyone
   * who could reach the path could read every queued job payload (customer
   * emails, phones, order ids) and retry or delete jobs.
   *
   * Nest prefixes middleware routes with the global prefix, so the board
   * really lives under `${API_PREFIX}/admin/queues`; the bare path is kept
   * too. Swagger also serves `/api/docs-yaml`, which `/api/docs` does not
   * cover (Express matches path segments, not string prefixes) — it was the
   * one copy of the API description left public.
   *
   * Applied in every environment, not just production: a dashboard that is
   * open locally is a dashboard someone eventually exposes.
   */
  const OPERATOR_PATHS = [
    "/api/docs", "/api/docs-json", "/api/docs-yaml",
    "/admin/queues", `${env.API_PREFIX.replace(/\/+$/, "")}/admin/queues`,
  ];
  app.use(OPERATOR_PATHS, (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    const [user, pass] = Buffer.from(scheme === "Basic" ? encoded ?? "" : "", "base64").toString().split(":");

    // Constant-time, and length-guarded so timingSafeEqual cannot throw.
    const ok =
      safeEqual(user ?? "", env.DOCS_USER) && safeEqual(pass ?? "", env.DOCS_PASSWORD);
    if (ok) return next();

    res.set("WWW-Authenticate", `Basic realm="${BRAND.name} operator"`).status(401).send("Authentication required");
  });

  // Swagger
  const docConfig = new DocumentBuilder()
    .setTitle(`${BRAND.name} API`)
    .setDescription(`${BRAND.name} e-commerce backend — ${BRAND.brands.join(" and ")} coconut oils from ${BRAND.legalName}, Palakkad (${BRAND.tagline}). Unified DataResponseDto / ErrorResponseDto envelopes on every endpoint.`)
    .setVersion("1.0.0")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT", in: "header" })
    .addServer(`http://localhost:${env.PORT}`)
    .build();
  const document = SwaggerModule.createDocument(app, docConfig);
  SwaggerModule.setup("api/docs", app, document, { customSiteTitle: `${BRAND.name} API Docs` });

  getFirebase();

  // Schema provisioning report. This project ships no migrations, so an empty
  // database fails every query with `relation "..." does not exist`. The actual
  // CREATE happens in DatabaseModule (`synchronize: env.DB_AUTO_SYNC`) before
  // provider init; this only reports the outcome, so the boot log says
  // unambiguously whether the schema is present rather than leaving it to be
  // inferred from later query failures.
  const schemaLog = new Logger("Schema");
  try {
    const stamp = readFileSync("/app/BUILD_TIME", "utf8").trim();
    schemaLog.log(`Image built at ${stamp}`);
  } catch { /* not running from the container image */ }
  try {
    const sequelize = app.get(Sequelize, { strict: false });
    if (env.DB_AUTO_SYNC) {
      // DatabaseModule's `synchronize` flag is silently ignored by
      // @nestjs/sequelize while `autoLoadModels` is false, so the schema is
      // created here instead. Plain sync() = CREATE TABLE IF NOT EXISTS: it never
      // alters or drops an existing table. Runs before app.listen(), i.e. before
      // any onModuleInit hook (ZoneCacheService) or cron touches the tables.
      try {
        await sequelize.sync();
      } catch (e: any) {
        schemaLog.error(`DB_AUTO_SYNC failed: ${e?.message}`);
      }
    }
    const [rows]: any = await sequelize.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tables = rows?.[0]?.n ?? 0;
    schemaLog.log(`DB_AUTO_SYNC=${env.DB_AUTO_SYNC} · ${env.DB_NAME}@${env.DB_HOST}:${env.DB_PORT} · ${tables} tables`);
    if (tables === 0) {
      schemaLog.error(
        "Database has NO tables. Set DB_AUTO_SYNC=true and redeploy, or run `node dist/scripts/sync-db.js`. " +
        "Every request will fail with 'relation ... does not exist' until this is resolved.",
      );
    } else if (env.DB_AUTO_SYNC) {
      // Zone bands are cached during onModuleInit, which runs before this point.
      // On the very first boot against a fresh database that cache came up empty,
      // so refresh it now that the tables exist instead of needing a restart.
      try {
        await app.get(ZoneCacheService, { strict: false }).onModuleInit();
      } catch { /* already reported by ZoneCacheService */ }
    }
  } catch (e: any) {
    schemaLog.error(`Could not verify schema: ${e?.message}`);
  }

  // Share Socket.IO rooms across instances. Must be registered before listen,
  // because that is when the Socket.IO server is created.
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connect();
  app.useWebSocketAdapter(ioAdapter);

  /*
   * Refuse to ship a route nobody decided the access rules for.
   *
   * PermissionsGuard allows any route carrying no permission metadata, which
   * is correct for the 111 ownership-scoped self-service routes but fails
   * open for anything new. This asks the question at deploy time instead:
   * a route that is neither public, nor permission-gated, nor on the
   * self-service list stops the boot in production and is logged loudly
   * everywhere else.
   */
  // PermissionsGuard enforces the same classification per request (deny by
  // default); hand it the handlers before the first request can arrive.
  const selfService = registerSelfServiceHandlers(app as unknown as { container: any });
  new Logger("RouteGates").log(`${selfService} self-service route(s) registered; every other ungated route is denied`);

  const ungated = auditRouteGates(app as unknown as { container: any });
  if (ungated.length) {
    const list = ungated.map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler})`);
    const message =
      `${ungated.length} route(s) are reachable by any authenticated user and are not on the ` +
      `self-service list: ${list.join(", ")}. Add @RequirePermissions(...), or add them to ` +
      `SELF_SERVICE_ROUTES once you have confirmed the handler scopes by the caller.`;
    if (isProd) throw new Error(message);
    new Logger("RouteGates").warn(message);
  }

  await app.listen(env.PORT);
  const log = new Logger("Bootstrap");
  log.log(`🚀 ${BRAND.name} API listening on http://localhost:${env.PORT}${env.API_PREFIX}`);
  log.log(`📚 Swagger UI  → http://localhost:${env.PORT}/api/docs`);
}

bootstrap();
