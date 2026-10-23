// Phase B3 — validation, money clamps, data exposure, CSV, search logging.
// Asserts the CLOSED behaviour; local test API and database only.
import crypto from "node:crypto";
import { api, data, login, q, check, section, done, said, uniq, clientIp } from "./lib.mjs";

const A = (await login("admin@shapthagiri-edibles.com", "admin")).accessToken;
const C = (await login("customer@shapthagiri-edibles.com", "customer")).accessToken;
const [order] = await q(`select o.id, o.total from orders o join users u on u.id = o."userId" where u.email = 'customer@shapthagiri-edibles.com' order by o."createdAt" limit 1`);

section("bodies that used to skip validation");
{
  const r1 = await api("POST", "/orders/preview", { body: { subtotal: "abc" }, headers: { "x-forwarded-for": clientIp() } });
  check("public order preview rejects a non-numeric subtotal", r1.status === 422 || r1.status === 400, said(r1));
  const r2 = await api("POST", "/orders/preview", { body: { subtotal: -500, giftCardBalance: -1e9 }, headers: { "x-forwarded-for": clientIp() } });
  check("…and negative money", r2.status === 422 || r2.status === 400, said(r2));
  const r3 = await api("PATCH", "/notifications/preferences", { token: C, body: { emailEnabled: "yes" } });
  // The global pipe converts implicitly ("yes" -> true) before @IsBoolean runs;
  // what matters is that a boolean is stored, never the string.
  const pref = data(r3)?.preferences?.emailEnabled;
  check("notification preferences are stored as booleans only", r3.status === 422 || r3.status === 400 || typeof pref === "boolean", `${said(r3)} stored ${JSON.stringify(pref)}`);
  const r4 = await api("PATCH", "/notifications/preferences", { token: C, body: { emailEnabled: false, injected: { $where: "1" } } });
  const stored = JSON.stringify(data(r4) ?? {});
  check("unknown preference keys are stripped, not stored", r4.status < 300 && !stored.includes("injected"), `${said(r4)} ${stored.slice(0, 120)}`);
  const ids = Array.from({ length: 600 }, () => crypto.randomUUID());
  const r5 = await api("POST", "/notifications/inbox/bulk", { token: C, body: { action: "delete", ids } });
  check("bulk inbox action refuses 600 ids", r5.status === 422 || r5.status === 400, said(r5));
  const r6 = await api("GET", "/disputes/me?limit=100000", { token: C });
  check("dispute list refuses limit=100000", r6.status === 422 || r6.status === 400, said(r6));
  const r7 = await api("GET", "/orders/admin/routing/decisions?shopId=not-a-uuid", { token: A });
  check("routing log refuses a malformed shopId (was a raw SQL error)", r7.status === 422 || r7.status === 400, said(r7));
  const r8 = await api("GET", "/disputes/me?order=asc", { token: C });
  check("regression: lower-case sort direction is accepted", r8.status === 200, said(r8));
}

section("numeric filters inside SQL literals");
for (const qs of ["maxPrice=abc", "minRating=Infinity", "minDiscount=1e999", "categoryId=not-a-uuid,also-not"]) {
  const r = await api("GET", `/catalog/products?${qs}`, { headers: { "x-forwarded-for": clientIp() } });
  check(`GET /catalog/products?${qs} → 200, not a 500`, r.status === 200, said(r));
}

section("money: refunds never exceed what was paid");
{
  // A captured payment that already has a pending refund for its whole amount.
  const [pay] = await q(`insert into payments (id, "orderId", method, gateway, amount, status, "createdAt", "updatedAt")
                         values (gen_random_uuid(), $1, 'upi', 'mock', 100, 'captured', now(), now()) returning id`, [order.id]);
  await q(`insert into payment_refunds (id, "paymentId", amount, status, reason, "createdAt", "updatedAt")
           values (gen_random_uuid(), $1, 100, 'pending', 'queued by a cancellation', now(), now())`, [pay.id]);
  const r = await api("POST", "/payments/refunds", { token: A, body: { paymentId: pay.id, amount: 100, reason: "probe" } });
  check("a second full refund on top of a pending one is refused", r.status === 409 || r.status === 400, `${said(r)} ${r.json?.message ?? ""}`);

  const dispute = data(await api("POST", "/disputes", { token: C, body: { orderId: order.id, issue: "B3 probe" } }));
  const res = await api("POST", `/disputes/${dispute.id}/resolve`, { token: A, body: { resolutionType: "refund_wallet", resolution: "B3 probe", amount: 99999 } });
  const [w] = await q(`select coalesce(sum(amount), 0)::float8 as credited from wallet_transactions where "idempotencyKey" = $1`, [`dispute-${dispute.id}`]).catch(() => [{ credited: "n/a" }]);
  check(`dispute resolution cannot pay out more than the order total (₹${order.total})`, res.status === 400 || res.status === 422, `${said(res)} ${res.json?.message ?? ""}; credited ${w?.credited}`);
}

section("data exposure");
{
  const list = data(await api("GET", "/catalog/products?limit=5", { headers: { "x-forwarded-for": clientIp() } }));
  const slug = list?.items?.find((p) => p.slug)?.slug;
  const detail = await api("GET", `/catalog/products/${slug}`, { headers: { "x-forwarded-for": clientIp() } });
  const body = JSON.stringify(detail.json);
  check("public product detail carries no costPrice", detail.status === 200 && !body.includes("costPrice"), said(detail));
  check("…and no submittedBy", !body.includes("submittedBy"));
  const sr = await api("GET", "/search/products?q=oil", { headers: { "x-forwarded-for": clientIp() } });
  check("search results carry no costPrice", sr.status === 200 && !JSON.stringify(sr.json).includes("costPrice"), said(sr));

  const od = await api("GET", `/orders/me/${order.id}`, { token: C });
  const ob = JSON.stringify(od.json);
  check("customer order detail carries no idempotency key or gateway order id", od.status === 200 && !ob.includes("idempotencyKey") && !ob.includes("gatewayReferenceId"), said(od));

  const pm = await api("POST", "/users/me/payment-methods", { token: C, body: { type: "card", brand: "visa", last4: "4242", gatewayToken: "tok_secret_probe" } });
  check("saving a payment method does not echo the gateway token", pm.status < 300 && !JSON.stringify(pm.json).includes("tok_secret_probe"), said(pm));
}

section("CSV exports cannot carry formulas");
{
  await q(`insert into audit_logs (id, action, entity, "entityId", "createdAt", "updatedAt") values (gen_random_uuid(), '=HYPERLINK("http://x","click")', 'Probe', $1, now(), now())`, [uniq()]);
  await q(`insert into audit_logs (id, action, entity, "entityId", "createdAt", "updatedAt") values (gen_random_uuid(), E'\\t=1+1', 'Probe', $1, now(), now())`, [uniq()]);
  const csv = await api("GET", "/admin/audit-logs/export", { token: A, raw: true });
  const text = csv.text ?? "";
  check("audit export defuses a leading = (formula shown as text)", text.includes(`"'=HYPERLINK(`) && !text.includes(`"=HYPERLINK(`), said(csv));
  check("…and a leading tab", text.includes(`"'\t=1+1"`));
}

section("search log");
{
  const long = "x".repeat(250);
  const r = await api("GET", `/search/products?q=${long}`, { headers: { "x-forwarded-for": clientIp() } });
  check("a 250-character search answers 200 (it used to 500 on the log insert)", r.status === 200, said(r));
  const [{ n: before }] = await q(`select count(*)::int n from search_queries`);
  await api("GET", "/search/products?q=", { headers: { "x-forwarded-for": clientIp() } });
  await api("GET", "/search/products?q=%20%20", { headers: { "x-forwarded-for": clientIp() } });
  const [{ n: after }] = await q(`select count(*)::int n from search_queries`);
  check("empty searches write no log rows", after === before, `${before} → ${after}`);
}

await done();
process.exit(process.exitCode ?? 0);
