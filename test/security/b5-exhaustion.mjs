// Phase B5 — resource exhaustion. Local test API and database only.
//
// The renderer, cache and timeout helpers are exercised in-process through
// the compiled code; caps on request bodies, lists and exports over HTTP.
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { api, data, login, q, check, section, done, said, clientIp } from "./lib.mjs";

const A = (await login("admin@shapthagiri-edibles.com", "admin")).accessToken;
const C = (await login("customer@shapthagiri-edibles.com", "customer")).accessToken;

section("array bodies are capped");
{
  const merge = await api("POST", "/cart/merge", { token: C, body: { items: Array.from({ length: 150 }, () => ({ variantId: crypto.randomUUID(), quantity: 1 })) } });
  check("cart merge refuses 150 lines", merge.status === 422 || merge.status === 400, said(merge));
  const apply = await api("POST", "/promotions/coupons/apply", { token: C, body: { code: "X", cartTotal: 100, items: Array.from({ length: 300 }, () => ({})) }, headers: { "x-forwarded-for": clientIp() } });
  check("coupon apply refuses 300 items", apply.status === 422 || apply.status === 400, said(apply));
  const role = await api("POST", "/rbac/roles", { token: A, body: { name: `Huge ${crypto.randomUUID().slice(0, 6)}`, permissions: Array.from({ length: 600 }, (_, i) => `x.${i}`) } });
  check("a role with 600 permission keys is refused", role.status === 422 || role.status === 400, said(role));
}

section("regression: ordinary array bodies are still accepted");
{
  // A cap that rejects the storefront's own requests is an outage, not a fix.
  // (An element validator added here once did exactly that to the public
  // promotion badges call; this block exists because of it.)
  const [v] = await q(`select v.id, v."productId" from product_variants v join products p on p.id = v."productId" where p.status = 'published' limit 1`);
  const line = { variantId: v.id, productId: v.productId, quantity: 1, price: 100 };
  const badges = await api("POST", "/promotions/promotions/badges", { body: { items: [line, line] }, headers: { "x-forwarded-for": clientIp() } });
  check("public promotion badges with two lines → accepted", badges.status < 300, said(badges));
  const apply = await api("POST", "/promotions/coupons/apply", { token: C, body: { code: "NOPE", cartTotal: 100, items: [line] }, headers: { "x-forwarded-for": clientIp() } });
  check("coupon apply with real lines is not a validation error", apply.status !== 422 && apply.status !== 400 || /coupon|code/i.test(apply.json?.message ?? ""), `${said(apply)} ${apply.json?.message ?? ""}`);
  const merge = await api("POST", "/cart/merge", { token: C, body: { items: [{ variantId: v.id, quantity: 1 }] } });
  check("cart merge with one real line → accepted", merge.status < 300, said(merge));
  const [o] = await q(`select o.id from orders o join users u on u.id = o."userId" where u.email = 'customer@shapthagiri-edibles.com' limit 1`);
  const disp = await api("POST", "/disputes", { token: C, body: { orderId: o.id, issue: "attachments regression", attachments: ["https://example.com/a.jpg"] } });
  check("dispute with an attachment list → accepted", disp.status < 300, said(disp));
}

section("lists and exports are capped");
{
  const cats = await api("GET", "/catalog/categories?page=1&limit=100000", { headers: { "x-forwarded-for": clientIp() } });
  const n = Array.isArray(data(cats)) ? data(cats).length : (data(cats)?.items?.length ?? 0);
  check("categories ignore limit=100000 beyond 100", cats.status === 200 && n <= 100, `${said(cats)} rows=${n}`);

  // 20,050 audit rows, then an export asking for a million.
  await q(`insert into audit_logs (id, action, entity, "entityId", "createdAt", "updatedAt")
           select gen_random_uuid(), 'bulk-probe', 'Probe', g::text, now() - (g || ' seconds')::interval, now() from generate_series(1, 20050) g`);
  const exp = await api("GET", "/admin/audit-logs/export?limit=1000000", { token: A, raw: true });
  const lines = (exp.text ?? "").split("\n").filter(Boolean).length - 1;
  check("audit export stops at 20,000 rows whatever is asked", exp.status === 200 && lines <= 20_000, `${said(exp)} rows=${lines}`);
  await q(`delete from audit_logs where action = 'bulk-probe'`);
}

// In-process from here: the compiled modules, with a media bucket configured
// for this process only so the renderer's allowlist has a host to allow.
process.env.AWS_S3_BUCKET = "verify-bucket"; process.env.AWS_REGION = "us-east-1";
process.env.DOTENV_CONFIG_PATH = path.resolve(".env.localtest");
const fromDist = createRequire(path.resolve("dist/main.js"));

section("the PDF renderer only fetches from our media bucket");
{
  const { isAllowedResource, isPrivateAddress } = fromDist("./common/utils/pdf.util");
  const refused = [
    "https://localhost/x.png", "https://127.0.0.1/x.png", "https://2130706433/x.png", "https://[::1]/x.png",
    "https://100.64.1.1/x.png", "https://10.0.0.5/x.png", "https://169.254.169.254/latest/meta-data/",
    "https://evil.example/x.png", "http://verify-bucket.s3.us-east-1.amazonaws.com/x.png", "file:///etc/passwd",
  ];
  for (const u of refused) check(`refused: ${u}`, (await isAllowedResource(u)) === false);
  for (const u of ["about:blank", "data:image/png;base64,iVBORw0KGgo=", "https://verify-bucket.s3.us-east-1.amazonaws.com/products/a.png"]) {
    check(`allowed: ${u.slice(0, 60)}`, (await isAllowedResource(u)) === true);
  }
  for (const a of ["::ffff:10.0.0.1", "fc00::1", "fe80::1", "100.127.255.255", "0.0.0.0"]) check(`private: ${a}`, isPrivateAddress(a));
  for (const a of ["8.8.8.8", "100.128.0.1", "2001:4860:4860::8888"]) check(`public: ${a}`, !isPrivateAddress(a));
}

section("20 concurrent renders");
{
  const { htmlToPdf } = fromDist("./common/utils/pdf.util");
  const html = "<html><body><h1>Invoice</h1><p>Probe</p><img src='https://169.254.169.254/x.png'></body></html>";
  globalThis.gc?.();
  const base = process.memoryUsage().rss;
  const t0 = Date.now();
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => htmlToPdf(html, `probe-${i}`)));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message);
  check("all 20 renders completed (none refused by the render gate)", ok.length === 20, `${ok.length} ok in ${Date.now() - t0} ms${failed.length ? `; ${failed[0]}` : ""}`);
  const pdf = ok[0];
  check("output is a real PDF: %PDF header and %%EOF trailer", !!pdf && pdf.subarray(0, 5).toString() === "%PDF-" && pdf.subarray(-32).toString("latin1").includes("%%EOF"), pdf ? `${pdf.length} bytes` : "none");
  await new Promise((r) => setTimeout(r, 1500));
  globalThis.gc?.();
  const after = process.memoryUsage().rss;
  check("memory returns near baseline (browsers closed)", after - base < 80 * 1024 * 1024, `rss ${Math.round(base / 1048576)} → ${Math.round(after / 1048576)} MB`);
}

section("one real render over HTTP");
{
  const [o] = await q(`select o.id from orders o join users u on u.id = o."userId" where u.email = 'customer@shapthagiri-edibles.com' and (o."paymentMethod" = 'cod' or o."paymentStatus" = 'captured') order by o."createdAt" limit 1`);
  const res = await fetch(`http://localhost:9175/api/v1/payments/invoices/${o.id}/pdf`, { headers: { authorization: `Bearer ${C}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  check("invoice PDF from the API is a complete PDF", res.status === 200 && buf.subarray(0, 5).toString() === "%PDF-" && buf.subarray(-32).toString("latin1").includes("%%EOF"), `${res.status} ${res.headers.get("content-type")} ${buf.length} bytes`);
}

section("cache and timeouts");
{
  const { CacheService } = fromDist("./services/cache.service");
  const c = new CacheService();
  let threw = false;
  try { for (let i = 0; i < 6_000; i++) c.set(`k:${i}`, { i }); } catch { threw = true; }
  check("the in-process cache stops at its ceiling without throwing", !threw && c.get("k:0") !== undefined && c.get("k:5999") === undefined);
  const { withTimeout } = fromDist("./common/utils/timeout.util");
  const t = Date.now();
  let msg = "";
  try { await withTimeout(new Promise(() => {}), 200, "probe call"); } catch (e) { msg = e.message; }
  check("a hung third-party call is abandoned after its timeout", /timed out/.test(msg) && Date.now() - t < 1_000, msg);
}

await done();
process.exit(process.exitCode ?? 0);
