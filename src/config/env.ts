import "dotenv/config";
import { cleanEnv, str, port, bool, num } from "envalid";

export const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ["development", "test", "production"], default: "development" }),
  PORT: port({ default: 9165 }),
  API_PREFIX: str({ default: "/api/v1" }),

  DB_HOST: str({ default: "localhost" }),
  DB_PORT: port({ default: 5432 }),
  DB_USER: str({ default: "postgres" }),
  DB_PASSWORD: str({ default: "postgres" }),
  DB_NAME: str({ default: "shapthagiri" }),
  DB_LOGGING: bool({ default: false }),
  DB_AUTO_SYNC: bool({ default: false }),

  JWT_ACCESS_SECRET: str({ default: "dev-access-secret-change-me" }),
  JWT_REFRESH_SECRET: str({ default: "dev-refresh-secret-change-me" }),
  JWT_ACCESS_EXPIRES: str({ default: "15m" }),
  // 14 days, matching the session row's lifetime (auth.service REFRESH_TTL_MS).
  JWT_REFRESH_EXPIRES: str({ default: "14d" }),

  CORS_ORIGINS: str({ default: "http://localhost:9164" }),

  // Where to purge the storefront's Next.js fetch cache after a product or
  // inventory write. Without it the storefront only notices a change when its
  // own 600 s timer expires, which is why switching an item off on the
  // Inventory screen could appear to do nothing for a quarter of an hour.
  // Both must be set for the purge to fire; unset, it is skipped silently and
  // the timer remains the only mechanism.
  WEB_REVALIDATE_URL: str({ default: "" }),
  WEB_REVALIDATE_SECRET: str({ default: "" }),

  // false = run without Redis (local dev): in-memory key/value store, notification
  // jobs run in-process, coupon scheduler on a timer. Single instance only.
  REDIS_ENABLED: bool({ default: true }),
  REDIS_HOST: str({ default: "localhost" }),
  REDIS_PORT: port({ default: 6379 }),
  REDIS_PASSWORD: str({ default: "" }),

  PAYMENT_HOLD_MINUTES: num({ default: 20 }),

  ENABLE_PUSH: bool({ default: true }),
  ENABLE_SMS: bool({ default: true }),
  ENABLE_EMAIL: bool({ default: true }),
  ENABLE_RATE_LIMIT: bool({ default: true }),

  DOCS_USER: str({ default: "admin" }),
  DOCS_PASSWORD: str({ default: "admin" }),

  // Accepts fake OTP tokens ("stub-token-+91...") so the phone flow can be
  // exercised without Firebase credentials. Development only — the production
  // guard below refuses to boot with it on, because anyone who can reach the
  // API could otherwise mint a session for any phone number.
  ALLOW_OTP_STUB: bool({ default: false }),

  // Signs the guest order-tracking magic links. Must be set in production.
  ORDER_LOOKUP_SECRET: str({ default: "" }),

  // Firebase (SMS OTP via Firebase Auth + FCM push)
  FIREBASE_PROJECT_ID: str({ default: "" }),
  FIREBASE_CLIENT_EMAIL: str({ default: "" }),
  FIREBASE_PRIVATE_KEY: str({ default: "" }),

  // Nodemailer (email)
  MAIL_HOST: str({ default: "smtp.gmail.com" }),
  MAIL_PORT: port({ default: 587 }),
  MAIL_SECURE: bool({ default: false }),
  MAIL_USER: str({ default: "" }),
  MAIL_PASS: str({ default: "" }),
  MAIL_FROM: str({ default: "Shapthagiri Edibles <shapthagirirefineries@gmail.com>" }),

  // Gmail (app-password) — preferred when set. Read from .env, never hardcoded.
  GMAIL_USER: str({ default: "" }),
  GMAIL_APP_PASSWORD: str({ default: "" }),

  // Payments — gateway-agnostic. Defaults to a built-in "mock" gateway when no
  // key secret is configured.
  // false = cash on delivery only. Orders and payment calls refuse online payment,
  // so the mock gateway (used when no key secret is set) can never capture money,
  // and the Razorpay keys are not required to boot in production.
  ONLINE_PAYMENTS_ENABLED: bool({ default: true }),
  PAYMENT_GATEWAY: str({ default: "mock" }),
  PAYMENT_KEY_ID: str({ default: "" }),
  PAYMENT_KEY_SECRET: str({ default: "" }),
  // Shared secret for the Razorpay webhook. You choose this string, paste it
  // into the Razorpay dashboard when creating the webhook, and set it here —
  // Razorpay is not the one who issues it. Empty means webhooks are rejected.
  PAYMENT_WEBHOOK_SECRET: str({ default: "" }),
  PAYMENT_CURRENCY: str({ default: "INR" }),

  // AWS S3
  AWS_ACCESS_KEY_ID: str({ default: "" }),
  AWS_SECRET_ACCESS_KEY: str({ default: "" }),
  AWS_REGION: str({ default: "ap-south-1" }),
  AWS_S3_BUCKET: str({ default: "" }),
});

export const isProd = env.NODE_ENV === "production";
export const isDev = env.NODE_ENV === "development";

/**
 * Fail fast in production if security-critical secrets are still the shipped
 * development defaults. This prevents a deploy from silently running with
 * forgeable JWTs or a default DB password.
 */
const INSECURE_DEFAULTS: Array<[string, string]> = [
  ["JWT_ACCESS_SECRET", "dev-access-secret-change-me"],
  ["JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"],
  ["DB_PASSWORD", "postgres"],
];
if (isProd) {
  const offenders = INSECURE_DEFAULTS.filter(([key, def]) => (env as Record<string, unknown>)[key] === def).map(([key]) => key);
  if (offenders.length) {
    throw new Error(
      `Refusing to start in production with default secrets: ${offenders.join(", ")}. Set strong values in the environment.`,
    );
  }
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ in production.");
  }
  if (env.ALLOW_OTP_STUB) {
    throw new Error("ALLOW_OTP_STUB must be off in production: it accepts any string as proof of phone ownership.");
  }

  /*
   * Secrets whose ABSENCE silently downgrades security rather than breaking
   * anything loudly — the dangerous kind.
   *
   * With PAYMENT_KEY_SECRET empty the provider falls back to the literal HMAC
   * key "mock" and its verification helpers return true unconditionally, so
   * anyone could have an order marked captured. An empty
   * PAYMENT_WEBHOOK_SECRET rejects every real webhook with only a warning in
   * the log. An empty ORDER_LOOKUP_SECRET weakens guest order tracking. And
   * DOCS_PASSWORD defaults to "admin", which would publish the full API
   * surface behind admin/admin.
   *
   * None of these stop the app booting, which is exactly why they need to be
   * checked here.
   */
  const requiredInProd: Array<[string, string]> = [
    // Only while online payment is on; with it off nothing reaches the gateway.
    ...(env.ONLINE_PAYMENTS_ENABLED
      ? ([
          ["PAYMENT_KEY_SECRET", "payments would accept forged signatures"],
          ["PAYMENT_WEBHOOK_SECRET", "every gateway webhook would be rejected"],
        ] as Array<[string, string]>)
      : []),
    ["ORDER_LOOKUP_SECRET", "guest order-tracking links would be forgeable"],
    ["DOCS_PASSWORD", "API docs would be published behind admin/admin"],
  ];
  const missing = requiredInProd.filter(([key]) => !(env as Record<string, unknown>)[key]);
  if (missing.length) {
    throw new Error(
      `Refusing to start in production without: ${missing.map(([k, why]) => `${k} (${why})`).join("; ")}.`,
    );
  }
  // The docs password guards the full API description and the queue dashboard
  // (every queued job's payload). "Set" is not enough — it defaults to "admin".
  if (env.DOCS_PASSWORD === "admin" || env.DOCS_PASSWORD.length < 16 || env.DOCS_PASSWORD === env.DOCS_USER) {
    throw new Error("DOCS_PASSWORD must be at least 16 characters and not the default in production (it guards the API docs and the queue dashboard).");
  }
  // Online payment through the mock gateway would accept every signature and
  // report every order captured. Production either takes no online payment
  // or uses a real gateway.
  if (env.ONLINE_PAYMENTS_ENABLED && env.PAYMENT_GATEWAY === "mock") {
    throw new Error("ONLINE_PAYMENTS_ENABLED is on with PAYMENT_GATEWAY=mock in production — set a real gateway or turn online payment off.");
  }
}
