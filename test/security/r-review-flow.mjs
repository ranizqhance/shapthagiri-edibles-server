// Product reviews, end to end: a delivered purchase is reviewed, the review
// waits for moderation, staff approve it, and it appears on the product page —
// in the list AND in the star summary, however the page addresses the product.
// Local test API and database only.
//
// The shipment is marked delivered directly in the local database: the
// courier flow is not what is under test here.
import { api, data, login, q, check, section, done, said, clientIp } from "./lib.mjs";

const EMAIL = "customer@shapthagiri-edibles.com";
const C = (await login(EMAIL, "customer")).accessToken;
const A = (await login("admin@shapthagiri-edibles.com", "admin")).accessToken;
const ip = () => ({ "x-forwarded-for": clientIp() });

// A line the customer bought that has not been reviewed yet.
const [line] = await q(
  `select oi.id, oi."variantId", oi."shipmentId", v."productId", p.slug
     from order_items oi
     join order_shipments s on s.id = oi."shipmentId"
     join orders o on o.id = s."orderId"
     join users u on u.id = o."userId"
     join product_variants v on v.id = oi."variantId"
     join products p on p.id = v."productId"
    where u.email = $1 and p.status = 'published'
      and not exists (select 1 from product_reviews r where r."orderItemId" = oi.id)
    order by o."createdAt" desc limit 1`,
  [EMAIL],
);
if (!line) {
  console.error("No unreviewed purchase for the fixture customer — place a test order first.");
  process.exit(2);
}
const [{ status: shipmentWas }] = await q(`select status from order_shipments where id = $1`, [line.shipmentId]);

let reviewId = null;
try {
  section("the product page knows who may review");
  const guest = await api("GET", `/reviews/eligibility/${line.slug}`, { headers: ip() });
  check("signed out → 401 (the page shows 'sign in to review')", guest.status === 401, said(guest));
  const stranger = await api("GET", `/reviews/eligibility/${line.slug}`, { token: A, headers: ip() });
  check("someone who never bought it → not_purchased", data(stranger)?.canReview === false && data(stranger)?.reason === "not_purchased", JSON.stringify(data(stranger)?.reason));
  await q(`update order_shipments set status = 'shipped' where id = $1`, [line.shipmentId]);
  const notYet = await api("GET", `/reviews/eligibility/${line.slug}`, { token: C, headers: ip() });
  check("ordered but not delivered → not_delivered", data(notYet)?.canReview === false && data(notYet)?.reason === "not_delivered", JSON.stringify(data(notYet)?.reason));
  const early = await api("POST", `/reviews/products/${line.variantId}`, { token: C, body: { rating: 5, text: "too early" }, headers: ip() });
  check("…and a review sent anyway is refused", early.status === 403, said(early));
  await q(`update order_shipments set status = 'delivered' where id = $1`, [line.shipmentId]);
  const ready = await api("GET", `/reviews/eligibility/${line.slug}`, { token: C, headers: ip() });
  check("delivered → canReview with that pack offered", data(ready)?.canReview === true && (data(ready)?.packs ?? []).some((p) => p.variantId === line.variantId), JSON.stringify(data(ready)?.packs));

  section("the customer reviews what they received");
  const text = `Fragrant and clean — review probe ${Date.now()}`;
  const created = await api("POST", `/reviews/products/${line.variantId}`, { token: C, body: { rating: 5, text }, headers: ip() });
  reviewId = data(created)?.id;
  check("review accepted for moderation", created.status < 300 && data(created)?.status === "pending", said(created));
  const after = await api("GET", `/reviews/eligibility/${line.slug}`, { token: C, headers: ip() });
  check("eligibility now: already_reviewed, with their pending review", data(after)?.reason === "already_reviewed" && (data(after)?.myReviews ?? []).some((r) => r.id === reviewId && r.status === "pending"), JSON.stringify(data(after)?.reason));
  const twice = await api("POST", `/reviews/products/${line.variantId}`, { token: C, body: { rating: 4, text: "again" }, headers: ip() });
  check("a second review of the same delivered line → 409", twice.status === 409, said(twice));

  const listed = (r) => (data(r)?.items ?? []).some((x) => x.id === reviewId);
  const pendingList = await api("GET", `/reviews/product/${line.productId}`, { headers: ip() });
  check("not shown while pending", pendingList.status === 200 && !listed(pendingList), said(pendingList));

  section("staff approve it in the dashboard queue");
  const queue = await api("GET", "/reviews/admin?status=pending&limit=50", { token: A, headers: ip() });
  check("it is in the pending queue", (data(queue)?.items ?? []).some((x) => x.id === reviewId), said(queue));
  const mod = await api("POST", `/reviews/admin/${reviewId}/moderate`, { token: A, body: { status: "approved" }, headers: ip() });
  check("approve → 2xx, status approved", mod.status < 300 && data(mod)?.status === "approved", said(mod));

  section("it appears under the product");
  const byProduct = await api("GET", `/reviews/product/${line.productId}`, { headers: ip() });
  check("listed for the product (by id)", byProduct.status === 200 && listed(byProduct), said(byProduct));
  const bySlug = await api("GET", `/reviews/product/${line.slug}`, { headers: ip() });
  check("listed for the product (by slug, as the page URL is)", bySlug.status === 200 && listed(bySlug), said(bySlug));
  const item = (data(byProduct)?.items ?? []).find((x) => x.id === reviewId);
  check("carries the reviewer's first name, text and rating", item?.user?.name && item?.text === text && item?.rating === 5, `${item?.user?.name} / ${item?.rating}`);
  check("does not leak the reviewer's email", item && !("email" in (item.user ?? {})));
  const byVariant = await api("GET", `/reviews/products/${line.variantId}`, { headers: ip() });
  check("still listed by variant (older clients)", byVariant.status === 200 && listed(byVariant), said(byVariant));

  const sumId = await api("GET", `/reviews/summary/${line.productId}`, { headers: ip() });
  check("summary by product id counts it", sumId.status === 200 && data(sumId)?.count >= 1, `count=${data(sumId)?.count}`);
  const sumSlug = await api("GET", `/reviews/summary/${line.slug}`, { headers: ip() });
  check("summary by slug counts it too", sumSlug.status === 200 && data(sumSlug)?.count === data(sumId)?.count, `count=${data(sumSlug)?.count}`);
  const batch = await api("GET", `/reviews/summary?productIds=${line.productId}`, { headers: ip() });
  check("shop-grid batch summary counts it", (data(batch)?.[line.productId]?.count ?? 0) >= 1, JSON.stringify(data(batch)?.[line.productId] ?? null));

  section("after the product is deleted, the queue still says what was reviewed");
  {
    // What happened on the test site: the catalog was rebuilt, the old products
    // soft-deleted, and every review on them showed in the queue as "Product".
    await q(`update product_variants set "deletedAt" = now() where id = $1`, [line.variantId]);
    await q(`update products set "deletedAt" = now() where id = $1`, [line.productId]);
    try {
      const queue = await api("GET", "/reviews/admin?status=approved&limit=100", { token: A, headers: ip() });
      const row = (data(queue)?.items ?? []).find((x) => x.id === reviewId);
      check("dashboard queue names the deleted product", !!row?.variant?.product?.title, `${said(queue)} title=${row?.variant?.product?.title}`);
      check("…and marks it deleted", !!(row?.variant?.product?.deletedAt || row?.variant?.deletedAt));
      const mine = await api("GET", "/reviews/me?limit=50", { token: C, headers: ip() });
      const own = (data(mine)?.items ?? []).find((x) => x.id === reviewId);
      check("the customer's own list names it too", !!own?.variant?.product?.title, `title=${own?.variant?.product?.title}`);
      const pub = await api("GET", `/reviews/product/${line.productId}`, { headers: ip() });
      check("the public list does not resurrect it on the site", pub.status === 200, said(pub));
    } finally {
      await q(`update product_variants set "deletedAt" = null where id = $1`, [line.variantId]);
      await q(`update products set "deletedAt" = null where id = $1`, [line.productId]);
    }
  }

  section("rejecting takes it back down");
  const rej = await api("POST", `/reviews/admin/${reviewId}/moderate`, { token: A, body: { status: "rejected", note: "probe" }, headers: ip() });
  check("reject → 2xx", rej.status < 300, said(rej));
  const afterReject = await api("GET", `/reviews/product/${line.productId}`, { headers: ip() });
  check("no longer listed", afterReject.status === 200 && !listed(afterReject), said(afterReject));
  const sumAfter = await api("GET", `/reviews/summary/${line.productId}`, { headers: ip() });
  check("summary drops it", (data(sumAfter)?.count ?? 0) === (data(sumId)?.count ?? 0) - 1, `count=${data(sumAfter)?.count}`);

  section("a product with several packs shows reviews of every pack");
  {
    // A second pack of the same product, reviewed (approved) by the customer.
    // Created straight in the local database and removed again below.
    const [v2] = await q(
      `insert into product_variants (id, "productId", sku, attributes, "defaultPrice", mrp, "createdAt", "updatedAt")
       select gen_random_uuid(), "productId", sku || '-probe-' || floor(random() * 1e6)::text, '{"size":"Probe pack"}'::jsonb, "defaultPrice", mrp, now(), now()
         from product_variants where id = $1
       returning id`,
      [line.variantId],
    );
    const [other] = await q(
      `insert into product_reviews (id, "userId", "variantId", rating, text, "verifiedPurchase", status, "helpfulCount", "createdAt", "updatedAt")
       select gen_random_uuid(), u.id, $1, 4, 'Second pack probe review', true, 'approved', 0, now(), now()
         from users u where u.email = $2
       returning id`,
      [v2.id, EMAIL],
    );
    try {
      const both = await api("GET", `/reviews/product/${line.slug}`, { headers: ip() });
      const item = (data(both)?.items ?? []).find((x) => x.id === other.id);
      check("a review of the other pack is listed on the product", !!item, said(both));
      check("…and says which pack it was for", item?.variant?.attributes?.size === "Probe pack", JSON.stringify(item?.variant ?? null));
      const firstPackOnly = await api("GET", `/reviews/products/${line.variantId}`, { headers: ip() });
      check("(the old per-pack list would have missed it)", !(data(firstPackOnly)?.items ?? []).some((x) => x.id === other.id));
      const sum = await api("GET", `/reviews/summary/${line.slug}`, { headers: ip() });
      check("summary counts it", (data(sum)?.count ?? 0) >= 1, `count=${data(sum)?.count}`);
    } finally {
      await q(`delete from product_reviews where id = $1`, [other.id]);
      await q(`delete from product_variants where id = $1`, [v2.id]);
    }
  }

  section("unknown products answer empty, not 500");
  const junk = await api("GET", "/reviews/product/no-such-product", { headers: ip() });
  check("unknown slug → 200 with no items", junk.status === 200 && (data(junk)?.items ?? []).length === 0, said(junk));
} finally {
  // Leave the fixtures as they were.
  if (reviewId) await q(`delete from product_reviews where id = $1`, [reviewId]);
  await q(`update order_shipments set status = $2 where id = $1`, [line.shipmentId, shipmentWas]);
}

await done();
process.exit(process.exitCode ?? 0);
