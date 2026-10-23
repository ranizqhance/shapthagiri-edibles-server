// Phase B2 — rate limits. Local test API only. Each block uses fresh client
// addresses (X-Forwarded-For, read through `trust proxy` = 1 exactly as
// Traefik's would be) and fresh identifiers, so one check cannot exhaust the
// budget another relies on.
import { api, data, login, check, section, done, said, uniq, clientIp, ORIGIN } from "./lib.mjs";

const hammer = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) out.push((await fn(i)).status); return out; };
const summary = (codes) => codes.join(",");

section("login — per IP");
{
  const ip = clientIp();
  const codes = await hammer(6, (i) => api("POST", "/auth/login", { body: { email: `nobody-${uniq()}@example.test`, password: "wrong" }, headers: { "x-forwarded-for": ip } }));
  check("6th failed login from one IP → 429 (different addresses each time)", codes.slice(0, 5).every((c) => c === 401) && codes[5] === 429, summary(codes));
  const other = await api("POST", "/auth/login", { body: { email: `nobody-${uniq()}@example.test`, password: "wrong" }, headers: { "x-forwarded-for": clientIp() } });
  check("a second client address has its own budget (proves trust proxy reads the forwarded IP)", other.status === 401, said(other));
}

section("login — per account");
{
  const email = `target-${uniq()}@example.test`;
  const codes = await hammer(6, () => api("POST", "/auth/login", { body: { email, password: "wrong" }, headers: { "x-forwarded-for": clientIp() } }));
  check("6th failed login on one account → 429 even from 6 different IPs", codes.slice(0, 5).every((c) => c === 401) && codes[5] === 429, summary(codes));
  const realAfter = await api("POST", "/auth/login", { body: { email: "customer@shapthagiri-edibles.com", password: "customer" }, headers: { "x-forwarded-for": clientIp() } });
  check("no lockout spill-over: a different account still signs in", realAfter.status === 200, said(realAfter));
}

section("sending a code — per address");
{
  const email = `otp-${uniq()}@example.test`;
  const codes = await hammer(4, () => api("POST", "/auth/otp/email/send", { body: { email }, headers: { "x-forwarded-for": clientIp() } }));
  check("4th code to the same address within the hour → 429, across IPs", codes.slice(0, 3).every((c) => c < 300) && codes[3] === 429, summary(codes));
}

section("vouchers — 20 per hour");
{
  const C = (await login("customer@shapthagiri-edibles.com", "customer")).accessToken;
  const ip = clientIp();
  const codes = await hammer(21, () => api("POST", "/cart/coupon", { token: C, body: { code: `NOPE${uniq()}` }, headers: { "x-forwarded-for": ip } }));
  check("21st coupon attempt from one client → 429", codes.slice(0, 20).every((c) => c !== 429) && codes[20] === 429, summary(codes.slice(17)));
}

section("exports and PDFs — 5 per minute per session");
{
  const s1 = (await login("admin@shapthagiri-edibles.com", "admin", { "x-forwarded-for": clientIp() })).accessToken;
  // Back to back on purpose: access tokens carry a unique id, so two logins
  // in the same second are two sessions with two budgets.
  const s2 = (await login("admin@shapthagiri-edibles.com", "admin", { "x-forwarded-for": clientIp() })).accessToken;
  const codes = await hammer(6, () => api("GET", "/admin/audit-logs/export", { token: s1 }));
  check("6th export in a minute from one session → 429", codes.slice(0, 5).every((c) => c === 200) && codes[5] === 429, summary(codes));
  const other = await api("GET", "/admin/audit-logs/export", { token: s2 });
  check("another session keeps its own budget", other.status === 200, said(other));
}

section("search — 30 per minute");
{
  const ip = clientIp();
  const codes = await hammer(31, () => api("GET", `/search/products?q=oil`, { headers: { "x-forwarded-for": ip } }));
  check("31st search from one client in a minute → 429", codes.slice(0, 30).every((c) => c === 200) && codes[30] === 429, summary(codes.slice(28)));
}

section("health");
{
  const pub = await api("GET", "/health", { headers: { "x-forwarded-for": clientIp() } });
  const keys = Object.keys(data(pub) ?? {});
  check("public /health says only its status", pub.status === 200 && keys.join() === "status", JSON.stringify(data(pub)));
  const anon = await api("GET", "/health/details");
  check("detail needs a signed-in staff account", anon.status === 401, said(anon));
  const A = (await login("admin@shapthagiri-edibles.com", "admin")).accessToken;
  const det = await api("GET", "/health/details", { token: A });
  check("admin sees the detail (uptime, queue)", det.status === 200 && "uptime" in (data(det) ?? {}), said(det));
  const C = (await login("customer@shapthagiri-edibles.com", "customer")).accessToken;
  const cus = await api("GET", "/health/details", { token: C });
  check("a customer does not", cus.status === 403, said(cus));
}

await done();
