// B1 — browser-side payment confirmation is bound to the order's owner.
// Needs the local API started with ONLINE_PAYMENTS_ENABLED=true (mock gateway,
// local only): the route refuses everything while online payment is off.
import crypto from "node:crypto";
import { api, login, phoneSignIn, data, q, check, section, done, said, uniq } from "./lib.mjs";

section("B1 — payments/verify");
const [order] = await q(`select o.id from orders o join users u on u.id = o."userId" where u.email = 'customer@shapthagiri-edibles.com' order by o."createdAt" limit 1`);
const ref = `order_verify_${uniq()}`;
await q(`insert into payments (id, "orderId", method, gateway, amount, status, "gatewayReferenceId", "createdAt", "updatedAt")
         values (gen_random_uuid(), $1, 'upi', 'mock', 1, 'pending', $2, now(), now())`, [order.id, ref]);
const paymentId = `pay_${uniq()}`;
const signature = crypto.createHmac("sha256", "mock").update(`${ref}|${paymentId}`).digest("hex");
const body = { razorpay_order_id: ref, razorpay_payment_id: paymentId, razorpay_signature: signature };

const stranger = data(await phoneSignIn(`+9197${String(crypto.randomInt(0, 1e8)).padStart(8, "0")}`));
const r1 = await api("POST", "/payments/verify", { token: stranger.accessToken, body });
check("another account cannot confirm this order's payment (answers like a missing payment)", r1.status === 404, said(r1));
const owner = await login("customer@shapthagiri-edibles.com", "customer");
const r2 = await api("POST", "/payments/verify", { token: owner.accessToken, body });
check("regression: the order's own customer can", r2.status < 300, said(r2));
await done();
process.exit(process.exitCode ?? 0);
