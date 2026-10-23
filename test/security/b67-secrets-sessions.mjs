// Phases B6 + B7 — fail-closed configuration, payments with online payment
// off, the webhook, and sessions. Local test API and database only.
//
// The webhook section needs the API started with ONLINE_PAYMENTS_ENABLED=true
// and PAYMENT_WEBHOOK_SECRET=whsec_local_probe (run with WEBHOOK=1 then);
// everything else runs against the normal local test API.
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { api, data, login, q, check, section, done, said, clientIp, uniq } from "./lib.mjs";

if (process.env.WEBHOOK !== "1") {
section("B6 — production refuses to boot on an insecure configuration");
{
  // A configuration that passes, then one change at a time. Validation runs
  // when config/env is loaded, before anything connects, so nothing here
  // touches a database or the network.
  const good = {
    NODE_ENV: "production", DOTENV_CONFIG_PATH: path.resolve("does-not-exist.env"),
    JWT_ACCESS_SECRET: "a".repeat(40), JWT_REFRESH_SECRET: "b".repeat(40), DB_PASSWORD: "probe-db-password",
    ORDER_LOOKUP_SECRET: "c".repeat(32), DOCS_USER: "ops", DOCS_PASSWORD: "d".repeat(24),
    ALLOW_OTP_STUB: "false", ONLINE_PAYMENTS_ENABLED: "false",
  };
  const boot = (env) => {
    try {
      execFileSync(process.execPath, ["-e", "require('./dist/config/env')"], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      return "booted";
    } catch (e) {
      return String(e.stderr).match(/Error: ([^\n]+)/)?.[1] ?? "failed";
    }
  };
  check("baseline production config boots", boot(good) === "booted", boot(good));
  const cases = [
    ["JWT_ACCESS_SECRET left at the dev default", { JWT_ACCESS_SECRET: "dev-access-secret-change-me" }, /JWT_ACCESS_SECRET/],
    ["both JWT secrets equal", { JWT_REFRESH_SECRET: "a".repeat(40) }, /must differ/],
    ["DB_PASSWORD left at the default", { DB_PASSWORD: "postgres" }, /DB_PASSWORD/],
    ["OTP stub on", { ALLOW_OTP_STUB: "true" }, /ALLOW_OTP_STUB/],
    ["ORDER_LOOKUP_SECRET missing", { ORDER_LOOKUP_SECRET: "" }, /ORDER_LOOKUP_SECRET/],
    ["DOCS_PASSWORD left at admin", { DOCS_PASSWORD: "admin" }, /DOCS_PASSWORD/],
    ["DOCS_PASSWORD too short", { DOCS_PASSWORD: "short-pass" }, /DOCS_PASSWORD/],
    ["online payment through the mock gateway", { ONLINE_PAYMENTS_ENABLED: "true", PAYMENT_GATEWAY: "mock", PAYMENT_KEY_SECRET: "k", PAYMENT_WEBHOOK_SECRET: "w" }, /PAYMENT_GATEWAY=mock/],
    ["online payment without a webhook secret", { ONLINE_PAYMENTS_ENABLED: "true", PAYMENT_GATEWAY: "razorpay", PAYMENT_KEY_SECRET: "k" }, /PAYMENT_WEBHOOK_SECRET/],
  ];
  for (const [label, change, names] of cases) {
    const out = boot({ ...good, ...change });
    check(`refuses: ${label}`, out !== "booted" && names.test(out), out.slice(0, 140));
  }
  // The real deploy configuration (values never printed) still passes.
  const live = boot({ NODE_ENV: "production", DOTENV_CONFIG_PATH: path.resolve("dokploy-api.env") });
  check("the live deploy env file passes the production checks", live === "booted", live === "booted" ? "booted" : live.slice(0, 140));
}

section("B6 — with online payment off, nothing is reconciled as paid");
{
  const C = (await login("customer@shapthagiri-edibles.com", "customer")).accessToken;
  const [o] = await q(`select o.id from orders o join users u on u.id = o."userId" where u.email = 'customer@shapthagiri-edibles.com' order by o."createdAt" limit 1`);
  await q(`update orders set "paymentMethod" = 'upi', "paymentStatus" = 'pending' where id = $1`, [o.id]);
  const [p] = await q(`insert into payments (id, "orderId", method, gateway, amount, status, "gatewayReferenceId", "createdAt", "updatedAt") values (gen_random_uuid(), $1, 'upi', 'mock', 10, 'pending', $2, now() - interval '1 hour', now()) returning id`, [o.id, `order_jit_${uniq()}`]);
  const view = await api("GET", `/orders/me/${o.id}`, { token: C });
  const [after] = await q(`select status from payments where id = $1`, [p.id]);
  check("opening the order does not mark a pending online payment captured", view.status === 200 && after.status === "pending", `${said(view)} payment=${after.status}`);
  await q(`update orders set "paymentMethod" = 'cod' where id = $1`, [o.id]);
}

section("B7 — tokens");
{
  const ip = clientIp();
  const a = await api("POST", "/auth/login", { body: { email: "manager@shapthagiri-edibles.com", password: "manager" }, headers: { "x-forwarded-for": ip } });
  const b = await api("POST", "/auth/login", { body: { email: "manager@shapthagiri-edibles.com", password: "manager" }, headers: { "x-forwarded-for": ip } });
  check("two logins in the same second get different access tokens (jti)", data(a)?.accessToken && data(a).accessToken !== data(b).accessToken);
  const claims = JSON.parse(Buffer.from(data(a).accessToken.split(".")[1], "base64url"));
  check("access token says type=access and carries a jti", claims.type === "access" && !!claims.jti, JSON.stringify({ type: claims.type, jti: !!claims.jti }));

  const asRefresh = await api("POST", "/auth/refresh", { body: { refreshToken: data(a).accessToken } });
  check("an access token is refused as a refresh token", asRefresh.status === 401, said(asRefresh));
  const asBearer = await api("GET", "/auth/me", { token: data(a).refreshToken });
  check("a refresh token is refused as an access token", asBearer.status === 401, said(asBearer));
}

section("B7 — rotation and replay");
{
  const s = data(await api("POST", "/auth/login", { body: { email: "customer@shapthagiri-edibles.com", password: "customer" }, headers: { "x-forwarded-for": clientIp() } }));
  const r1 = await api("POST", "/auth/refresh", { body: { refreshToken: s.refreshToken } });
  check("refresh once → a new pair", r1.status < 300 && !!data(r1)?.refreshToken, said(r1));
  const replay = await api("POST", "/auth/refresh", { body: { refreshToken: s.refreshToken } });
  check("replaying the spent token → 401", replay.status === 401, said(replay));
  const next = await api("POST", "/auth/refresh", { body: { refreshToken: data(r1).refreshToken } });
  check("…and the whole family is revoked: the new refresh token fails too", next.status === 401, said(next));
  const me = await api("GET", "/auth/me", { token: data(r1).accessToken });
  check("…and its access token is dead (tokenVersion bumped)", me.status === 401, said(me));

  const s2 = data(await api("POST", "/auth/login", { body: { email: "admin@shapthagiri-edibles.com", password: "admin" }, headers: { "x-forwarded-for": clientIp() } }));
  const hash = crypto.createHash("sha256").update(s2.refreshToken).digest("hex");
  await q(`delete from user_sessions where "refreshTokenHash" = $1`, [hash]);
  const orphan = await api("POST", "/auth/refresh", { body: { refreshToken: s2.refreshToken } });
  check("a validly signed refresh token with no session row is refused (no more adoption)", orphan.status === 401, said(orphan));

  const s3 = data(await api("POST", "/auth/login", { body: { email: "partner@shapthagiri-edibles.com", password: "partner" }, headers: { "x-forwarded-for": clientIp() } }));
  const race = await Promise.all([0, 1].map(() => api("POST", "/auth/refresh", { body: { refreshToken: s3.refreshToken } })));
  const wins = race.filter((r) => r.status < 300).length;
  check("two simultaneous refreshes with one token: never both succeed", wins <= 1, race.map(said).join(", "));
}

section("B7 — login takes the same time for unknown and known accounts");
{
  const t = async (email, password) => {
    const t0 = performance.now();
    await api("POST", "/auth/login", { body: { email, password }, headers: { "x-forwarded-for": clientIp() } });
    return performance.now() - t0;
  };
  const unknown = [], wrong = [];
  for (let i = 0; i < 5; i++) {
    unknown.push(await t(`ghost-${uniq()}@example.test`, "whatever"));
    wrong.push(await t(["admin", "manager", "customer", "partner", "admin"][i] + "@shapthagiri-edibles.com", `wrong-${i}`));
  }
  const med = (xs) => xs.sort((x, y) => x - y)[2];
  const [mu, mw] = [med(unknown), med(wrong)];
  check("median time for an unknown address is within 60 ms of a wrong password", Math.abs(mu - mw) < 60, `unknown ${mu.toFixed(0)} ms vs wrong password ${mw.toFixed(0)} ms`);
}
}

if (process.env.WEBHOOK === "1") {
section("B6 — a signed webhook settles only the right amount");
{
  const secret = "whsec_local_probe";
  const [o] = await q(`select o.id from orders o join users u on u.id = o."userId" where u.email = 'customer@shapthagiri-edibles.com' order by o."createdAt" limit 1`);
  const ref = `order_wh_${uniq()}`;
  const [p] = await q(`insert into payments (id, "orderId", method, gateway, amount, status, "gatewayReferenceId", "createdAt", "updatedAt") values (gen_random_uuid(), $1, 'upi', 'razorpay', 250, 'pending', $2, now(), now()) returning id`, [o.id, ref]);
  const send = async (amount) => {
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_${uniq()}`, order_id: ref, amount, currency: "INR" } } } });
    const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    return fetch("http://localhost:9175/api/v1/webhooks/razorpay", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body: raw });
  };
  await send(100); // ₹1, for a ₹250 payment
  const [low] = await q(`select status from payments where id = $1`, [p.id]);
  check("a signed capture for less than the payment does not settle it", low.status === "pending", `payment=${low.status}`);
  await send(25000);
  const [ok] = await q(`select status from payments where id = $1`, [p.id]);
  check("regression: the right amount does", ok.status === "captured", `payment=${ok.status}`);
}
}

await done();
process.exit(process.exitCode ?? 0);
