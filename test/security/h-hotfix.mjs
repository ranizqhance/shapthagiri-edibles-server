// Phase H — the holes that were exploitable on the live API.
// Every check asserts the CLOSED behaviour, so a run against the old build
// fails exactly where each hole was. Local test API and database only (lib.mjs).
import crypto from "node:crypto";
import { api, data, login, phoneSignIn, q, check, section, done, said, uniq, ORIGIN, ENV, clientIp } from "./lib.mjs";

const VICTIM_EMAIL = "customer@shapthagiri-edibles.com";
const [victim] = await q(`select id, phone from users where email = $1`, [VICTIM_EMAIL]);
if (!victim) throw new Error("fixture missing: demo customer — run db:seed against the local DB");
const freshPhone = () => `+9198${String(crypto.randomInt(0, 1e8)).padStart(8, "0")}`;

section("H1 — sign-up never attaches to an account the caller has not proved");
{
  // Firebase/phone register with a NEW phone and the victim's email.
  const r = await api("POST", "/auth/register", {
    body: { idToken: `stub-token-${freshPhone()}`, name: "Attacker", email: VICTIM_EMAIL }, headers: { "x-forwarded-for": clientIp() },
  });
  const gotVictim = data(r)?.user?.id === victim.id;
  check("phone register + someone else's email is refused, no session for them", !gotVictim && r.status === 409, said(r) + (gotVictim ? " — SESSION FOR VICTIM" : ""));

  // Email-OTP register: prove a NEW email, claim the victim's phone.
  const email = `h1-${uniq()}@example.test`;
  const code = "424242";
  await q(
    `insert into otp_codes (id, identifier, channel, "codeHash", purpose, "expiresAt", consumed, attempts, "createdAt", "updatedAt")
     values (gen_random_uuid(), $1, 'email', $2, 'register', now() + interval '10 minutes', false, 0, now(), now())`,
    [email, crypto.createHash("sha256").update(code).digest("hex")],
  );
  const r2 = await api("POST", "/auth/register/verify-otp", { body: { email, code, name: "Attacker", phone: victim.phone } });
  const gotVictim2 = data(r2)?.user?.id === victim.id;
  check("email-OTP register + someone else's phone is refused, no session for them", !gotVictim2 && r2.status === 409, said(r2) + (gotVictim2 ? " — SESSION FOR VICTIM" : ""));
}

section("H2 — no password derived from the Firebase uid");
const attackerPhone = freshPhone();
const signIn = await phoneSignIn(attackerPhone);
const attacker = data(signIn);
check("fixture: attacker signs in with a fresh phone", signIn.status < 300 && !!attacker?.accessToken, said(signIn));
{
  const uid = `stub_uid_${attackerPhone.replace(/\D/g, "")}`;
  const r = await api("POST", "/auth/login", { body: { email: `${uid}@firebase.user`, password: `firebase_${uid}` }, headers: { "x-forwarded-for": clientIp() } });
  check("password login with 'firebase_<uid>' on the synthetic email fails", r.status === 401 || r.status === 400, said(r));
}
const A = attacker?.accessToken;

section("H3 — reorder needs the order to be yours");
{
  const [order] = await q(`select id from orders where "userId" = $1 limit 1`, [victim.id]);
  const r = await api("POST", `/orders/me/${order.id}/reorder`, { token: A });
  check("reorder of another customer's order → 404", r.status === 404, said(r) + (r.status < 300 ? ` added=${data(r)?.added}` : ""));
}

section("H4 — address PATCH does not return someone else's address");
{
  const v = await login(VICTIM_EMAIL, "customer");
  const made = await api("POST", "/users/me/addresses", {
    token: v.accessToken,
    body: { label: "Home", line1: "Victim street 1", city: "Palakkad", state: "Kerala", pincode: "678555", country: "IN", name: "Victim", phone: victim.phone },
  });
  const addrId = data(made)?.id;
  check("fixture: victim address created", !!addrId, said(made));
  const r = await api("PATCH", `/users/me/addresses/${addrId}`, { token: A, body: { label: "x" } });
  const leaked = JSON.stringify(r.json ?? "").includes("Victim street 1");
  check("PATCH another user's address → 404 and nothing leaked", r.status === 404 && !leaked, said(r) + (leaked ? " — ADDRESS LEAKED" : ""));
}

section("H5 — ownership is checked for every non-staff role, not only 'customer'");
{
  const partner = await login("partner@shapthagiri-edibles.com", "partner");
  const [order] = await q(`select id from orders where "userId" = $1 limit 1`, [victim.id]);
  const r = await api("POST", "/disputes", { token: partner.accessToken, body: { orderId: order.id, issue: "probe" } });
  check("delivery partner cannot file a dispute on a customer's order", r.status === 403 || r.status === 404, said(r));

  const t = await api("POST", "/support/tickets", { token: A, body: { subject: "probe", orderId: order.id } });
  check("support ticket cannot reference another customer's order", t.status === 403 || t.status === 404, said(t));
}

section("H6 — return inspection cannot push a refund above what was paid");
{
  const admin = await login("admin@shapthagiri-edibles.com", "admin");
  const [item] = await q(
    `select i.id, i."unitPrice" from order_items i join order_shipments s on s.id = i."shipmentId"
     join orders o on o.id = s."orderId" where o."userId" = $1 order by i."unitPrice" limit 1`, [victim.id]);
  const [ret] = await q(
    `insert into returns (id, "orderItemId", "userId", quantity, reason, status, method, "createdAt", "updatedAt")
     values (gen_random_uuid(), $1, $2, 1, 'probe', 'received_at_shop', 'pickup', now(), now()) returning id`,
    [item.id, victim.id]);
  const r = await api("POST", `/returns/${ret.id}/inspect`, {
    token: admin.accessToken, body: { status: "passed", deductRestockingFee: -1000 },
  });
  const [after] = await q(`select "refundAmount", status from returns where id = $1`, [ret.id]);
  const [audit] = await q(`select after from audit_logs where "entityId" = $1 and action = 'Refund Requested' order by "createdAt" desc limit 1`, [ret.id]);
  const requested = Number(audit?.after?.refundAmount ?? after?.refundAmount ?? 0);
  check(
    "negative restocking fee is rejected and no refund above the line price is requested",
    r.status === 400 || r.status === 422 ? requested <= Number(item.unitPrice) : false,
    `${said(r)}; line ₹${item.unitPrice}, refund requested ₹${requested}`,
  );

  const p = await api("POST", `/returns/${ret.id}/pickup-confirm`, { token: admin.accessToken, body: { status: "refunded" } });
  check("pickup-confirm refuses a status outside its own transitions", p.status === 400 || p.status === 422, said(p));
}

section("H7 — changing the phone number drops its verified flag");
{
  const before = data(await api("GET", "/users/me", { token: A }));
  const r = await api("PATCH", "/users/me", { token: A, body: { phone: freshPhone() } });
  const after = data(await api("GET", "/users/me", { token: A }));
  check("fixture: OTP account starts phone-verified", before?.phoneVerified === true);
  check("new unproven number is not marked verified", r.status < 300 && after?.phoneVerified === false, `${said(r)}; phoneVerified=${after?.phoneVerified}`);
  const clash = await api("PATCH", "/users/me", { token: A, body: { phone: victim.phone } });
  check("cannot take a number another account holds", clash.status === 409, said(clash));
}

section("H8 — operator surfaces need the operator password");
for (const p of ["/api/docs", "/api/docs-json", "/api/docs-yaml", `${ENV.API_PREFIX ?? "/api/v1"}/admin/queues`]) {
  const r = await api("GET", ORIGIN + p);
  check(`GET ${p} without credentials → 401`, r.status === 401, said(r));
}

section("H9 — delivery partners are created by staff only");
{
  const r = await api("POST", "/partners/onboard", { body: { name: "Probe", phone: freshPhone(), email: `p-${uniq()}@example.test`, vehicle: "bike" } });
  check("public POST /partners/onboard is gone", r.status === 404, said(r));
  const r2 = await api("POST", "/partners/register", { body: { userId: victim.id, vehicle: "bike" } });
  check("public POST /partners/register is gone", r2.status === 404, said(r2));
}



// ── Regressions: the fixes must not break the legitimate path ──────────────
section("H-R — legitimate use still works");
{
  const v = await login(VICTIM_EMAIL, "customer");
  const [order] = await q(`select id from orders where "userId" = $1 limit 1`, [victim.id]);
  const ro = await api("POST", `/orders/me/${order.id}/reorder`, { token: v.accessToken });
  check("customer reorders their own order", ro.status < 300, said(ro));

  const [addr] = await q(`select id from user_addresses where "userId" = $1 limit 1`, [victim.id]);
  const pa = await api("PATCH", `/users/me/addresses/${addr.id}`, { token: v.accessToken, body: { label: "Home (edited)" } });
  check("customer edits their own address", pa.status < 300 && data(pa)?.label === "Home (edited)", said(pa));

  const d = await api("POST", "/disputes", { token: v.accessToken, body: { orderId: order.id, issue: "regression probe" } });
  check("customer disputes their own order", d.status < 300, said(d));

  const t = await api("POST", "/support/tickets", { token: v.accessToken, body: { subject: "regression", orderId: order.id } });
  check("customer opens a ticket on their own order", t.status < 300, said(t));

  const again = await phoneSignIn(victim.phone);
  check("phone OTP with an existing number signs into that same account", data(again)?.user?.id === victim.id, said(again));

  const email = `hr-${uniq()}@example.test`;
  await q(`insert into otp_codes (id, identifier, channel, "codeHash", purpose, "expiresAt", consumed, attempts, "createdAt", "updatedAt")
           values (gen_random_uuid(), $1, 'email', $2, 'register', now() + interval '10 minutes', false, 0, now(), now())`,
          [email, crypto.createHash("sha256").update("515151").digest("hex")]);
  const reg = await api("POST", "/auth/register/verify-otp", { body: { email, code: "515151", name: "New Customer", phone: freshPhone() } });
  check("email-OTP registration with a new phone creates the account", reg.status < 300 && data(reg)?.user?.email === email, said(reg));

  // Inspection with a real fee, and pickup moves along their allowed path.
  const admin = await login("admin@shapthagiri-edibles.com", "admin");
  const [item] = await q(`select i.id, i."unitPrice" from order_items i join order_shipments s on s.id = i."shipmentId"
                          join orders o on o.id = s."orderId" where o."userId" = $1 order by i."unitPrice" desc limit 1`, [victim.id]);
  const [ret] = await q(`insert into returns (id, "orderItemId", "userId", quantity, reason, status, method, "createdAt", "updatedAt")
                         values (gen_random_uuid(), $1, $2, 1, 'probe', 'pickup_scheduled', 'pickup', now(), now()) returning id`, [item.id, victim.id]);
  const p1 = await api("POST", `/returns/${ret.id}/pickup-confirm`, { token: admin.accessToken, body: { status: "picked_up" } });
  const p2 = await api("POST", `/returns/${ret.id}/pickup-confirm`, { token: admin.accessToken, body: { status: "received_at_shop" } });
  check("pickup-confirm: pickup_scheduled → picked_up → received_at_shop", p1.status < 300 && p2.status < 300, `${said(p1)}, ${said(p2)}`);
  const ins = await api("POST", `/returns/${ret.id}/inspect`, { token: admin.accessToken, body: { status: "passed", deductRestockingFee: 99999 } });
  const [audit] = await q(`select after from audit_logs where "entityId" = $1 and action = 'Refund Requested' order by "createdAt" desc limit 1`, [ret.id]);
  check("an oversized fee is clamped: refund floors at ₹0, never negative", ins.status < 300 && Number(audit?.after?.refundAmount) === 0,
        `${said(ins)}; refund ₹${audit?.after?.refundAmount}, fee applied ₹${audit?.after?.restockingFee}`);
}

section("H-E — exchanges are bounded by what is coming back");
{
  const v = await login(VICTIM_EMAIL, "customer");
  const [item] = await q(`select i.id, i."variantId", i."productId", i."unitPrice" from order_items i join order_shipments s on s.id = i."shipmentId"
                          join orders o on o.id = s."orderId" where o."userId" = $1 order by i."unitPrice" limit 1`, [victim.id]);
  const [ret] = await q(`insert into returns (id, "orderItemId", "userId", quantity, reason, status, method, "createdAt", "updatedAt")
                         values (gen_random_uuid(), $1, $2, 1, 'probe', 'requested', 'pickup', now(), now()) returning id`, [item.id, victim.id]);
  const [other] = await q(`select id from product_variants where "productId" <> $1 limit 1`, [item.productId]);
  const [pricier] = await q(`select id from product_variants where "productId" = $1 and "defaultPrice" > $2 limit 1`, [item.productId, item.unitPrice]);

  const big = await api("POST", `/returns/${ret.id}/exchange`, { token: v.accessToken, body: { replacementVariantId: item.variantId, quantity: 5 } });
  check("more units than returned → refused", big.status === 400 || big.status === 422, said(big) + ` ${big.json?.message ?? ""}`);
  const wrong = await api("POST", `/returns/${ret.id}/exchange`, { token: v.accessToken, body: { replacementVariantId: other.id } });
  check("a different product → refused", wrong.status === 400 || wrong.status === 422, said(wrong) + ` ${wrong.json?.message ?? ""}`);
  if (pricier) {
    const up = await api("POST", `/returns/${ret.id}/exchange`, { token: v.accessToken, body: { replacementVariantId: pricier.id } });
    check("a pricier pack of the same product → refused", up.status === 400 || up.status === 422, said(up) + ` ${up.json?.message ?? ""}`);
  }
  const ok = await api("POST", `/returns/${ret.id}/exchange`, { token: v.accessToken, body: { replacementVariantId: item.variantId, quantity: 1 } });
  check("same pack, returned quantity → accepted (or refused only by policy/stock)", ok.status < 300 || /eligible|stock/i.test(ok.json?.message ?? ""), said(ok) + ` ${ok.json?.message ?? ""}`);
  if (ok.status < 300) {
    const twice = await api("POST", `/returns/${ret.id}/exchange`, { token: v.accessToken, body: { replacementVariantId: item.variantId, quantity: 1 } });
    check("a second exchange on the same return → 409", twice.status === 409, said(twice));
  }
}

await done();
