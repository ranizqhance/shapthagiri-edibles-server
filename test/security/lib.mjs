// Shared plumbing for the security verification scripts in this folder.
//
// They exist to PROVE a hole is closed by exercising it, so they are written to
// be run against a throwaway local API and database only. Both targets are
// checked before a single request is sent: the database must be on this
// machine, and so must the API. Run them from ecommerce-server/:
//
//   DOTENV_CONFIG_PATH=.env.localtest node dist/main.js     (in another shell)
//   node test/security/<script>.mjs
//
// Fixtures are created through the API or read from the local database; the
// scripts never assume an id exists.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";

const ENV_FILE = path.resolve(process.env.VERIFY_ENV_FILE ?? ".env.localtest");
if (!fs.existsSync(ENV_FILE)) {
  console.error(`REFUSING: ${ENV_FILE} not found. These checks only run against the local test setup.`);
  process.exit(2);
}
export const ENV = dotenv.parse(fs.readFileSync(ENV_FILE));

const LOCAL = /^(localhost|127\.0\.0\.1|::1)$/;
if (!LOCAL.test(ENV.DB_HOST ?? "")) {
  console.error(`REFUSING: DB_HOST in ${path.basename(ENV_FILE)} is not this machine.`);
  process.exit(2);
}

export const BASE = process.env.VERIFY_API ?? `http://localhost:${ENV.PORT ?? 9175}${ENV.API_PREFIX ?? "/api/v1"}`;
if (!LOCAL.test(new URL(BASE).hostname)) {
  console.error(`REFUSING: ${BASE} is not a local API.`);
  process.exit(2);
}
export const ORIGIN = new URL(BASE).origin;

/** One HTTP call. Never throws on a status; returns it with the parsed body. */
export async function api(method, p, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(p.startsWith("http") ? p : BASE + p, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text: raw ? text : undefined, headers: res.headers };
}

/** The `data` member of the API's success envelope, or the body itself. */
export const data = (r) => (r.json && "data" in r.json ? r.json.data : r.json);

/**
 * A distinct client address per call. The API trusts one proxy hop, so from
 * localhost an X-Forwarded-For is read exactly as Traefik's would be — each
 * fixture login gets its own rate-limit budget instead of exhausting the real
 * 5-per-15-minutes login limit the checks themselves rely on.
 */
export const clientIp = () => `10.${crypto.randomInt(0, 255)}.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

const sessions = new Map();
/** Sign in (once per run per account — later calls reuse the session). */
export async function login(email, password, headers) {
  if (!headers && sessions.has(email)) return sessions.get(email);
  const r = await api("POST", "/auth/login", { body: { email, password }, headers: headers ?? { "x-forwarded-for": clientIp() } });
  if (r.status >= 300) throw new Error(`login ${email} → ${r.status} ${r.json?.errorCode ?? ""}`);
  if (!headers) sessions.set(email, data(r));
  return data(r);
}

/**
 * Sign in "by phone" through the local OTP stub (ALLOW_OTP_STUB=true in
 * .env.localtest). The stub reads the number from the third dash-separated part.
 */
export async function phoneSignIn(phone) {
  return api("POST", "/auth/otp/checkout", { body: { idToken: `stub-token-${phone}` }, headers: { "x-forwarded-for": clientIp() } });
}

let client;
/** Query the LOCAL test database (host already checked above). */
export async function q(sql, params = []) {
  if (!client) {
    client = new pg.Client({
      host: ENV.DB_HOST, port: Number(ENV.DB_PORT ?? 5432), user: ENV.DB_USER,
      password: ENV.DB_PASSWORD, database: ENV.DB_NAME,
    });
    await client.connect();
  }
  return (await client.query(sql, params)).rows;
}

let failures = 0;
let passes = 0;
export function check(label, ok, detail = "") {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}
export const section = (title) => console.log(`\n== ${title}`);

export async function done() {
  if (client) await client.end();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}

/** Short tag for responses in the printed evidence. */
export const said = (r) => `${r.status}${r.json?.errorCode ? ` ${r.json.errorCode}` : ""}`;

export const uniq = () => Math.random().toString(36).slice(2, 8);
