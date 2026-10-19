import { Sequelize } from "sequelize";
import { ShopInventory, Shop } from "@/models";

/**
 * One definition of "a shopper can buy this", used by every public read.
 *
 * Before this file the rule was written out by hand in six places and omitted
 * in a dozen more, which produced two visible bugs:
 *
 *  - Setting an item Inactive on the Inventory screen changed nothing a shopper
 *    could see. `shop_inventory.isActive` is the only activity flag the schema
 *    has — `products` carries just `status`, and `product_variants` carries no
 *    flag at all — and the listing filtered on `status` alone.
 *
 *  - A card showed 200 units where the admin screen showed 50. The listing
 *    summed every inventory row for the product; the detail endpoint required
 *    the row's shop to exist and be active, and the admin screen is scoped to
 *    one shop. `shop_inventory` is not paranoid and nothing cascades when a
 *    shop is removed, so rows belonging to deleted shops survive and were
 *    counted by the card alone.
 *
 * Both follow from the same omission, so both are fixed by routing every read
 * through the helpers below.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidShopId(shopId?: string): shopId is string {
  return !!shopId && UUID_RE.test(shopId);
}

/** The inventory columns a storefront card or page actually reads. */
export const SELLABLE_INVENTORY_ATTRIBUTES = [
  "id",
  "variantId",
  "shopId",
  "isActive",
  "quantity",
  "priceOverride",
  "lowStockThreshold",
];

/**
 * Inventory rows a shopper may buy from: active row, at a shop that still
 * exists and is itself active.
 *
 * `required: false` throughout — a product with no sellable row must still come
 * back from the query so the caller can render it as unavailable rather than
 * have it silently vanish from a cart or a wishlist. Visibility is decided by
 * `visibleProductClause`, not by this join.
 */
export function sellableInventoryInclude(shopId?: string): any {
  return {
    model: ShopInventory,
    required: false,
    attributes: SELLABLE_INVENTORY_ATTRIBUTES,
    where: { isActive: true, ...(isValidShopId(shopId) ? { shopId } : {}) },
    include: [
      {
        model: Shop,
        attributes: [],
        required: true,
        where: { isActive: true },
      },
    ],
  };
}

/**
 * EXISTS clause: this product is sellable somewhere.
 *
 * Quantity is deliberately NOT part of it. Running out of stock is a temporary
 * state that should leave the product listed and its page indexed — the way
 * Amazon and Flipkart both behave — whereas Inactive means "do not offer this",
 * and that is the switch that hides it.
 *
 * `shopId` is UUID-validated by the caller before interpolation.
 */
export function sellableAnywhereLiteral(shopId?: string) {
  const shopScope = isValidShopId(shopId)
    ? ` AND "shop_inventory"."shopId" = '${shopId}'`
    : "";
  return Sequelize.literal(
    `EXISTS (
       SELECT 1 FROM "shop_inventory"
       INNER JOIN "product_variants" ON "product_variants"."id" = "shop_inventory"."variantId"
       INNER JOIN "shops" ON "shops"."id" = "shop_inventory"."shopId"
       WHERE "product_variants"."productId" = "Product"."id"
         AND "product_variants"."deletedAt" IS NULL
         AND "shop_inventory"."isActive" = true
         AND "shops"."isActive" = true${shopScope}
     )`,
  );
}

/**
 * The same rule as a correlated subquery against an arbitrary product-id
 * expression, for callers whose root model is not `Product` — the cart and
 * wishlist join from `product_variants`, and `categories.productCount` counts
 * from the products table under a different alias.
 */
export function sellableAnywhereSql(productIdExpr: string, shopId?: string): string {
  const shopScope = isValidShopId(shopId)
    ? ` AND si."shopId" = '${shopId}'`
    : "";
  return `EXISTS (
       SELECT 1 FROM "shop_inventory" si
       INNER JOIN "product_variants" siv ON siv."id" = si."variantId"
       INNER JOIN "shops" ss ON ss."id" = si."shopId"
       WHERE siv."productId" = ${productIdExpr}
         AND siv."deletedAt" IS NULL
         AND si."isActive" = true
         AND ss."isActive" = true${shopScope}
     )`;
}

/**
 * The storefront visibility gate, as a `where` fragment to spread into a query.
 *
 * `status: "published"` is unchanged from what the listing already did; the
 * EXISTS is the new part. Endpoints that were missing the status filter get it
 * here, which brings them in line with the listing beside them rather than
 * introducing a second control.
 */
export const PUBLISHED_ONLY = { status: "published" as const };

/** The companion AND-condition for `PUBLISHED_ONLY`. */
export function visibleProductClause(shopId?: string) {
  return sellableAnywhereLiteral(shopId);
}

/* ────────────────────────── shopper-facing availability ───────────────── */

type InventoryLike = {
  isActive?: boolean | null;
  quantity?: number | string | null;
  lowStockThreshold?: number | string | null;
};
type VariantLike = { inventory?: InventoryLike[] | null };

export interface Availability {
  inStock: boolean;
  /** At or below the configured threshold — the only case a number is shown. */
  lowStock: boolean;
  /**
   * Units remaining, and `null` whenever stock is comfortable.
   *
   * Null rather than the real figure on purpose: the number is then absent from
   * the payload, so no component can print it by accident. A storefront card
   * used to render "200 left", which no large marketplace does — the count is a
   * scarcity cue, not inventory disclosure.
   */
  unitsLeft: number | null;
}

/**
 * Availability for a product, from its already-filtered sellable rows.
 *
 * The threshold compared against is the SUM of the contributing rows'
 * `lowStockThreshold`, matching the way the quantities are summed: two shops
 * each holding a threshold of 5 means the product reads low below 10.
 */
export function availabilityOf(variants: VariantLike[] | null | undefined): Availability {
  let units = 0;
  let threshold = 0;

  for (const v of variants ?? []) {
    for (const inv of v.inventory ?? []) {
      // Rows arriving through `sellableInventoryInclude` are already active;
      // re-checked so the helper is also correct on an unfiltered payload.
      if (inv.isActive === false) continue;
      units += Number(inv.quantity ?? 0);
      threshold += Number(inv.lowStockThreshold ?? 0);
    }
  }

  const inStock = units > 0;
  const lowStock = inStock && units <= threshold;
  return { inStock, lowStock, unitsLeft: lowStock ? units : null };
}
