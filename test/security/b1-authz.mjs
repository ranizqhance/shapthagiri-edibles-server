// Phase B1 — authorization structure. Asserts the CLOSED behaviour; run against
// the old build it fails where each hole was. Local test API and database only.
//
// Fixtures are made here and checked before use: a second shop, a custom RBAC
// role, an account holding it, a "role-assigner" account that is not an admin,
// and a throwaway product. A check whose fixture is wrong would pass for the
// wrong reason, so each fixture is asserted first.
import path from "node:path";
import { createRequire } from "node:module";
import { api, data, login, q, check, section, done, said, uniq, clientIp, ORIGIN, ENV } from "./lib.mjs";

const fromWeb = createRequire(path.resolve("../ecommerce-web/package.json"));
const { io } = fromWeb("socket.io-client");
const fromDist = createRequire(path.resolve("dist/main.js"));

const admin = await login("admin@shapthagiri-edibles.com", "admin");
const manager = await login("manager@shapthagiri-edibles.com", "manager");
const customer = await login("customer@shapthagiri-edibles.com", "customer");
const A = admin.accessToken, M = manager.accessToken, C = customer.accessToken;

const [shopA] = await q(`select "shopId" as id from users where email = 'manager@shapthagiri-edibles.com'`);
let [shopB] = await q(`select id from shops where name = 'Verify Shop B'`);
if (!shopB) [shopB] = await q(`insert into shops (id, name, lat, lng, "isActive", "createdAt", "updatedAt") values (gen_random_uuid(), 'Verify Shop B', 10.8, 76.6, true, now(), now()) returning id`);
const [ship] = await q(`select s.id, s."orderId", s."shopId" from order_shipments s join orders o on o.id = s."orderId" join users u on u.id = o."userId" where u.email = 'customer@shapthagiri-edibles.com' order by s."createdAt" limit 1`);
check("fixture: manager belongs to shop A, the sample shipment is shop A's", !!shopA.id && ship.shopId === shopA.id);

section("B1.1 — deny by default");
{
  const { PermissionsGuard } = fromDist("./common/guards/permissions.guard");
  const { Reflector } = fromDist("@nestjs/core");
  const guard = new PermissionsGuard(new Reflector());
  const ctx = (handler) => ({ getHandler: () => handler, getClass: () => class Unclassified {}, switchToHttp: () => ({ getRequest: () => ({ user: { sub: "x", permissions: [] } }) }) });
  let verdict;
  try { verdict = guard.canActivate(ctx(function routeNobodyClassified() {})) ? "allowed" : "denied"; } catch (e) { verdict = `denied (${e.code ?? e.message})`; }
  check("a route with no permission metadata that nobody classified is denied", verdict.startsWith("denied"), verdict);

  const log = (await import("node:fs")).readFileSync(path.join(process.env.CLAUDE_JOB_DIR ?? "C:/Users/mubas/.claude/jobs/102910c2", "tmp/api.log"), "utf8");
  const line = (log.match(/\d+ self-service route\(s\) registered[^\n]*/) ?? [])[0];
  check("boot registers the self-service classification", !!line, line ?? "no registration line in the boot log");

  for (const [p, t, label] of [["/auth/me", C, "self-service /auth/me"], ["/cart", C, "self-service /cart"], ["/users/me/addresses", C, "self-service addresses"]]) {
    const r = await api("GET", p, { token: t });
    check(`${label} still works for a customer`, r.status === 200, said(r));
  }
  const r = await api("GET", "/finance/pnl", { token: C });
  check("permission-gated route refuses a customer", r.status === 403, said(r));
}

section("B1.2 — staff is judged by permission, not by the legacy role enum");
const roleName = `Verify viewer ${uniq()}`;
const role = data(await api("POST", "/rbac/roles", { token: A, body: { name: roleName, permissions: ["dashboard.view"] } }));
const viewerEmail = `viewer-${uniq()}@example.test`;
const made = await api("POST", "/admin/users", { token: A, body: { name: "Verify Viewer", email: viewerEmail, password: "Verify-viewer-pass-1", role: role?.key, roleId: role?.id } });
const [viewerRow] = await q(`select role from users where email = $1`, [viewerEmail]);
check("fixture: a custom role with only dashboard.view, stored as legacy enum 'support'", made.status < 300 && viewerRow?.role === "support", `${said(made)} enum=${viewerRow?.role}`);
{
  const V = (await login(viewerEmail, "Verify-viewer-pass-1")).accessToken;
  const s1 = await api("GET", `/shipments/${ship.id}`, { token: V });
  check("custom role without fulfilment/orders permission cannot read a shipment", s1.status === 403 || s1.status === 404, said(s1));
  const [dispute] = await q(`select id from disputes order by "createdAt" desc limit 1`);
  if (dispute) {
    const d1 = await api("GET", `/disputes/${dispute.id}`, { token: V });
    check("custom role without disputes permission cannot read a dispute", d1.status === 403 || d1.status === 404, said(d1));
  }
  const s2 = await api("GET", `/shipments/${ship.id}`, { token: C });
  check("regression: the customer still sees their own shipment", s2.status === 200, said(s2));
  const s3 = await api("GET", `/shipments/${ship.id}`, { token: M });
  check("regression: the shop's manager still sees it", s3.status === 200, said(s3));
}

section("B1.3 — a shop account is confined to its shop");
for (const p of ["/finance/pnl", "/finance/tax", "/finance/platform-wallet", "/orders/admin/routing/kpis", "/analytics/search/top"]) {
  const r = await api("GET", p, { token: M });
  check(`manager GET ${p} → 403 (platform-wide view)`, r.status === 403, said(r));
}
{
  const r = await api("GET", "/finance/pnl", { token: A });
  check("regression: admin still reads the P&L", r.status === 200, said(r));

  await q(`update order_shipments set "shopId" = $1 where id = $2`, [shopB.id, ship.id]);
  try {
    const c = await api("POST", `/orders/admin/${ship.orderId}/cancel`, { token: M, body: { reason: "probe" } });
    check("manager of shop A cannot cancel an order shop B fulfils (same 404 as missing)", c.status === 404, said(c));
    const re = await api("POST", `/orders/admin/shipments/${ship.id}/reassign`, { token: M, body: { newShopId: shopA.id, reason: "probe" } });
    check("manager of shop A cannot reassign shop B's shipment", re.status === 404, said(re));
  } finally {
    await q(`update order_shipments set "shopId" = $1 where id = $2`, [shopA.id, ship.id]);
  }

  // A throwaway product stocked by both shops.
  const slug = `verify-scope-${uniq()}`;
  const [prod] = await q(`insert into products (id, title, slug, status, "createdAt", "updatedAt") values (gen_random_uuid(), 'Verify scope product', $1, 'draft', now(), now()) returning id`, [slug]);
  const [variant] = await q(`insert into product_variants (id, "productId", sku, "defaultPrice", mrp, "createdAt", "updatedAt") values (gen_random_uuid(), $1, $2, 100, 120, now(), now()) returning id`, [prod.id, `VFY-${uniq()}`]);
  for (const sid of [shopA.id, shopB.id]) {
    await q(`insert into shop_inventory (id, "shopId", "variantId", quantity, "isActive", "createdAt", "updatedAt") values (gen_random_uuid(), $1, $2, 5, true, now(), now())`, [sid, variant.id]);
  }
  const pa = await api("PATCH", `/catalog/products/${prod.id}`, { token: M, body: { title: "Verify scope product", shopIds: [shopA.id], baseStock: 7 } });
  const rows = await q(`select "shopId", quantity from shop_inventory where "variantId" = $1`, [variant.id]);
  const bRow = rows.find((r) => r.shopId === shopB.id);
  check("manager saving the product form leaves shop B's inventory alone", !!bRow && Number(bRow.quantity) === 5, `${said(pa)}; shop B row ${bRow ? `qty ${bRow.quantity}` : "DELETED"}`);
  const del = await api("DELETE", `/catalog/products/${prod.id}`, { token: M });
  const [still] = await q(`select count(*)::int n from products where id = $1 and "deletedAt" is null`, [prod.id]).catch(() => q(`select count(*)::int n from products where id = $1`, [prod.id]));
  check("manager cannot delete a product another shop stocks", del.status === 403 && still.n === 1, `${said(del)}; product ${still.n ? "kept" : "DELETED"}`);
}

section("B1.4 — nobody grants what they do not hold");
{
  const assignerRole = data(await api("POST", "/rbac/roles", { token: A, body: { name: `Verify assigner ${uniq()}`, permissions: ["roles.view", "roles.assignUsers", "roles.edit", "roles.create", "users.view", "users.create", "users.editRole"] } }));
  const assignerEmail = `assigner-${uniq()}@example.test`;
  await api("POST", "/admin/users", { token: A, body: { name: "Verify Assigner", email: assignerEmail, password: "Verify-assigner-pass-1", role: assignerRole?.key, roleId: assignerRole?.id } });
  const S = (await login(assignerEmail, "Verify-assigner-pass-1")).accessToken;
  const me = data(await api("GET", "/auth/me", { token: S }));
  check("fixture: assigner holds roles.assignUsers but not the wildcard", Array.isArray(me?.permissions) && me.permissions.includes("roles.assignUsers") && !me.permissions.includes("*"));

  const [superRole] = await q(`select id from roles where key = 'super_admin'`);
  const r1 = await api("POST", `/rbac/users/${me.id}/assign-role`, { token: S, body: { roleId: superRole.id } });
  check("assigner cannot make themselves super_admin", r1.status === 403, said(r1));
  const r2 = await api("PATCH", `/admin/users/${me.id}/role`, { token: S, body: { role: "admin" } });
  check("assigner cannot make themselves admin through the user editor", r2.status === 403, said(r2));
  const r3 = await api("POST", "/admin/users", { token: S, body: { name: "Sneaky", email: `sneaky-${uniq()}@example.test`, password: "Sneaky-pass-12345", role: "admin" } });
  check("assigner cannot create an admin account", r3.status === 403, said(r3));
  const r4 = await api("PUT", `/rbac/roles/${assignerRole.id}/permissions`, { token: S, body: { permissions: [...me.permissions.filter((p) => p !== "*"), "finance.manageWallet"] } });
  check("assigner cannot add a permission they lack to their own role", r4.status === 403, said(r4));
  const r5 = await api("POST", "/rbac/roles", { token: S, body: { name: `Sneaky ${uniq()}`, permissions: ["finance.manageWallet"] } });
  check("assigner cannot create a role with permissions they lack", r5.status === 403, said(r5));
  const [adminUser] = await q(`select id from users where email = 'admin@shapthagiri-edibles.com'`);
  const r6 = await api("POST", `/rbac/users/${adminUser.id}/assign-role`, { token: S, body: { roleId: assignerRole.id } });
  check("assigner cannot re-role an account more privileged than themselves", r6.status === 403, said(r6));
  const lite = data(await api("POST", "/rbac/roles", { token: S, body: { name: `Verify lite ${uniq()}`, permissions: ["users.view"] } }));
  check("regression: assigner can create a role within their own permissions", !!lite?.id);
  const [viewer] = await q(`select id from users where email = $1`, [viewerEmail]);
  const r7 = await api("POST", `/rbac/users/${viewer.id}/assign-role`, { token: A, body: { roleId: lite.id } });
  check("regression: admin can still assign roles", r7.status < 300, said(r7));
}

section("B1.5 — WebSocket");
const connect = (opts) => new Promise((resolve) => {
  const s = io(ORIGIN, { transports: ["websocket"], reconnection: false, timeout: 4000, ...opts });
  let settled = false;
  const finish = (v) => { if (!settled) { settled = true; resolve({ s, ...v }); } };
  s.on("connect", () => setTimeout(() => finish({ connected: s.connected }), 600));
  s.on("disconnect", () => finish({ connected: false }));
  s.on("connect_error", () => finish({ connected: false }));
  setTimeout(() => finish({ connected: s.connected }), 4000);
});
{
  const viaQuery = await connect({ query: { token: C } });
  check("token in the query string is refused", !viaQuery.connected); viaQuery.s.close();
  const ok = await connect({ auth: { token: C } });
  check("regression: token in the handshake auth payload connects", ok.connected); ok.s.close();

  const [cu] = await q(`select id from users where email = 'customer@shapthagiri-edibles.com'`);
  await q(`update users set "isActive" = false where id = $1`, [cu.id]);
  try {
    const inactive = await connect({ auth: { token: C } });
    check("a deactivated account cannot open a socket with a still-valid token", !inactive.connected); inactive.s.close();
  } finally { await q(`update users set "isActive" = true where id = $1`, [cu.id]); }

  const fresh = await login("manager@shapthagiri-edibles.com", "manager", { "x-forwarded-for": clientIp() });
  await api("POST", "/auth/logout", { token: fresh.accessToken });
  const revoked = await connect({ auth: { token: fresh.accessToken } });
  check("a token from a logged-out session cannot open a socket", !revoked.connected); revoked.s.close();

  // shipment:status — the customer watches; a forged push from them must not arrive.
  const watcher = await connect({ auth: { token: C } });
  const M2 = (await login("manager@shapthagiri-edibles.com", "manager", { "x-forwarded-for": clientIp() })).accessToken;
  const shopSock = await connect({ auth: { token: M2 } });
  const got = [];
  watcher.s.on("shipment:status", (m) => got.push(m));
  watcher.s.emit("shipment:subscribe", ship.id);
  await new Promise((r) => setTimeout(r, 500));
  const forger = await connect({ auth: { token: C } });
  forger.s.emit("shipment:status", { shipmentId: ship.id, status: "delivered", note: "forged" });
  shopSock.s.emit("shipment:status", { shipmentId: ship.id, status: "out", injected: "<script>x</script>" });
  await new Promise((r) => setTimeout(r, 1200));
  check("a customer cannot push a status into a shipment room", !got.some((m) => m.status === "delivered"), JSON.stringify(got));
  const fromShop = got.find((m) => m.status === "out");
  check("the shop's push arrives with only shipmentId/status/ts (extra fields dropped)", !!fromShop && !("injected" in fromShop), JSON.stringify(fromShop));
  for (const x of [watcher, shopSock, forger]) x.s.close();
}

await done();
process.exit(process.exitCode ?? 0);
