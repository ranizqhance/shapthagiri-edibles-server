// Checkout payments: online through Razorpay, cash on delivery over WhatsApp.
// Local test API and database only.
//
// Start the API with online payment on (test-mode keys, so no money moves):
//   ONLINE_PAYMENTS_ENABLED=true PAYMENT_GATEWAY=razorpay PAYMENT_KEY_ID=rzp_test_… \
//   PAYMENT_KEY_SECRET=… PAYMENT_WEBHOOK_SECRET=… DOTENV_CONFIG_PATH=.env.localtest node dist/main.js
import path from "node:path";
import { createRequire } from "node:module";
import { api, data, login, q, check, section, done, said, clientIp } from "./lib.mjs";

const C = (await login("customer@shapthagiri-edibles.com", "customer")).accessToken;
const ip = () => ({ "x-forwarded-for": clientIp() });

section("checkout reads the online switch from the API");
{
  const s = await api("GET", "/settings/public", { headers: ip() });
  check("GET /settings/public carries payments.online", s.status === 200 && typeof data(s)?.["payments.online"] === "boolean", `${said(s)} payments.online=${data(s)?.["payments.online"]}`);
  check("…and the WhatsApp number cash on delivery goes to", !!String(data(s)?.["business.whatsappNumber"] ?? "").replace(/\D/g, ""));
}

section("cash on delivery creates no order");
{
  const [addr] = await q(`select a.* from user_addresses a join users u on u.id = a."userId" where u.email = 'customer@shapthagiri-edibles.com' limit 1`);
  const [v] = await q(`select v.id from product_variants v join products p on p.id = v."productId" where p.status = 'published' limit 1`);
  const before = await q(`select count(*)::int n from orders`);
  const r = await api("POST", "/orders", {
    token: C,
    headers: { ...ip(), "idempotency-key": `cod_probe_${Date.now()}` },
    body: {
      paymentMethod: "cod", buyNowVariantId: v.id, buyNowQuantity: 1,
      addressId: addr?.id, lat: Number(addr?.lat ?? 10.78), lng: Number(addr?.lng ?? 76.65),
      addressSnapshot: { fullName: "Probe", line1: addr?.line1 ?? "x", city: addr?.city ?? "x", state: addr?.state ?? "Kerala", pincode: addr?.pincode ?? "678001" },
    },
  });
  check("POST /orders with cod → 400 COD_VIA_WHATSAPP", r.status === 400 && r.json?.errorCode === "COD_VIA_WHATSAPP", said(r));
  const after = await q(`select count(*)::int n from orders`);
  check("no order row written", after[0].n === before[0].n, `${before[0].n} → ${after[0].n}`);
  const idem = await q(`select count(*)::int n from idempotency_keys where key like 'cod_probe_%'`).catch(() => [{ n: 0 }]);
  check("no idempotency row left behind", idem[0].n === 0, `${idem[0].n}`);
}

section("amounts reach the gateway in whole paise");
{
  const fromDist = createRequire(path.resolve("dist/main.js"));
  const { toPaise } = fromDist("./common/providers/payment.provider");
  check("₹145.50 → 14550 paise (not 14550.000000000002)", toPaise(145.5) === 14550, String(145.5 * 100));
  check("₹0.29 → 29 paise", toPaise(0.29) === 29, String(0.29 * 100));
  check("₹1168.39 → 116839 paise", toPaise("1168.39") === 116839, String(1168.39 * 100));
}

await done();
process.exit(process.exitCode ?? 0);
