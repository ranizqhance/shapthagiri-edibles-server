import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Op, Sequelize } from "sequelize";
import { Product, ProductVariant, ProductMedia, ShopInventory, Deal } from "@/models";
import { availabilityOf, sellableInventoryInclude, visibleProductClause } from "./availability";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Storefront read-model for the two INDEPENDENT home rails:
 *
 *  - Trending  → popularity ranking from real signals (sales, wishlist, reviews,
 *                ratings). No discount required, no admin curation.
 *  - Deals     → products with an ACTIVE Deal-of-the-Day promotion within its
 *                date window, ordered by admin-set priority.
 *
 * The two never share a query, so a product surfaces in both ONLY when it is
 * genuinely trending AND independently has a live deal.
 *
 * Both return products in the exact shape GET /catalog/products emits
 * (variants → inventory + media), so the frontend `mapBackendProduct` works
 * unchanged. Shop scoping mirrors the catalog listing: only published products
 * the serving shop has active, in-stock inventory for.
 */
@Injectable()
export class StorefrontService {
  constructor(
    @InjectModel(Product) private product: typeof Product,
    @InjectModel(ProductVariant) private variant: typeof ProductVariant,
    @InjectModel(ProductMedia) private media: typeof ProductMedia,
    @InjectModel(ShopInventory) private inv: typeof ShopInventory,
    @InjectModel(Deal) private deal: typeof Deal,
  ) {}

  private isValidShop(shopId?: string): shopId is string {
    return !!shopId && UUID_RE.test(shopId);
  }

  /** Card-shape include: variants (with their shop-scoped inventory) + media. */
  private productInclude(shopId?: string): any[] {
    // Sellable rows only — active inventory at a live, active shop. The home
    // rails previously summed every row, including ones left behind by a
    // deleted shop, and so could print a larger stock figure than the product
    // page or the admin screen for the same item.
    const invInclude: any = sellableInventoryInclude(this.isValidShop(shopId) ? shopId : undefined);
    return [
      { model: this.variant, include: [invInclude] },
      // Primary image first — the home rails and deals grid read media[0].
      { model: this.media, separate: true, order: [["sortOrder", "ASC"], ["createdAt", "ASC"]] },
    ];
  }

  /** EXISTS clause: product has active, in-stock inventory at the serving shop. */
  private shopScope(shopId: string) {
    return Sequelize.literal(
      `EXISTS (SELECT 1 FROM "shop_inventory" INNER JOIN "product_variants" ON "product_variants"."id" = "shop_inventory"."variantId" WHERE "product_variants"."productId" = "Product"."id" AND "shop_inventory"."shopId" = '${shopId}' AND "shop_inventory"."isActive" = true AND "shop_inventory"."quantity" > 0)`,
    );
  }

  /**
   * Weighted popularity score, all from real data:
   *   units sold ×5  +  wishlist saves ×2  +  approved reviews ×1  +  avg rating ×3
   * Correlated subqueries on "Product"."id" — safe with the default subQuery:true,
   * so LIMIT applies per product (not per joined variant/inventory/media row).
   */
  private trendScoreLiteral() {
    return Sequelize.literal(`(
      COALESCE((SELECT SUM(oi."quantity") FROM "order_items" oi WHERE oi."productId" = "Product"."id"), 0) * 5
      + (SELECT COUNT(*) FROM "wishlist_items" wi INNER JOIN "product_variants" wpv ON wpv."id" = wi."variantId" WHERE wpv."productId" = "Product"."id") * 2
      + (SELECT COUNT(*) FROM "product_reviews" rpr INNER JOIN "product_variants" rpv ON rpv."id" = rpr."variantId" WHERE rpv."productId" = "Product"."id" AND rpr."status" = 'approved' AND rpr."deletedAt" IS NULL) * 1
      + COALESCE((SELECT AVG(apr."rating") FROM "product_reviews" apr INNER JOIN "product_variants" apv ON apv."id" = apr."variantId" WHERE apv."productId" = "Product"."id" AND apr."status" = 'approved' AND apr."deletedAt" IS NULL), 0) * 3
    )`);
  }

  async trending(shopId: string | undefined, limit: number) {
    // Switched off on the Inventory screen = off the storefront, rails included.
    const where: any = { status: "published", [Op.and]: [visibleProductClause()] };
    if (this.isValidShop(shopId)) {
      where[Op.and].push(this.shopScope(shopId));
    }
    const score = this.trendScoreLiteral();
    const rows = await this.product.findAll({
      where,
      include: this.productInclude(shopId),
      attributes: { include: [[score, "trendScore"]] },
      // Newest first as the tie-breaker when scores match (e.g. a fresh catalog
      // where nothing has sold yet) so the rail is never empty.
      order: [[score, "DESC"], ["createdAt", "DESC"]],
      limit,
      // default subQuery:true → LIMIT applies to distinct products, not join rows.
    });
    return rows.map((r) => {
      const json = r.toJSON() as any;
      return { ...json, availability: availabilityOf(json.variants) };
    });
  }

  /** min active-inventory price, else variant default — mirrors mapBackendProduct. */
  private effectivePrice(p: any): { price: number; mrp: number } {
    const variant =
      p.variants?.find((v: any) => v.inventory?.some((i: any) => i.isActive && i.quantity > 0)) ||
      p.variants?.[0];
    let price = variant ? Number(variant.defaultPrice) : 0;
    const activeInv = variant?.inventory?.filter((i: any) => i.isActive && i.quantity > 0) || [];
    if (activeInv.length > 0) {
      price = activeInv.reduce((min: number, i: any) => {
        const cur = Number(i.priceOverride ?? variant.defaultPrice ?? 0);
        return cur < min ? cur : min;
      }, Infinity);
    }
    const mrp = variant ? Number(variant.mrp) : price;
    return { price, mrp };
  }

  private applyDiscount(price: number, type: string, value: number): number {
    const after = type === "pct" ? price * (1 - Number(value) / 100) : price - Number(value);
    return Math.max(0, Math.round(after * 100) / 100);
  }

  async deals(shopId: string | undefined, limit: number) {
    const now = new Date();
    // Active = flagged on AND now within [startsAt, endsAt] (null bound = open).
    const activeDeals = await this.deal.findAll({
      where: {
        isActive: true,
        [Op.and]: [
          { [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: now } }] },
          { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gte]: now } }] },
        ],
      },
      order: [["priority", "DESC"], ["endsAt", "ASC"]],
    });
    if (activeDeals.length === 0) return [];

    // One deal per product — highest priority already sorts first, so keep first.
    const bestByProduct = new Map<string, Deal>();
    for (const d of activeDeals) {
      if (!bestByProduct.has(d.productId)) bestByProduct.set(d.productId, d);
    }
    const productIds = Array.from(bestByProduct.keys());

    const where: any = {
      status: "published",
      id: { [Op.in]: productIds },
      [Op.and]: [visibleProductClause()],
    };
    if (this.isValidShop(shopId)) {
      where[Op.and].push(this.shopScope(shopId));
    }
    const products = await this.product.findAll({
      where,
      include: this.productInclude(shopId),
    });

    // Preserve deal priority ordering, attach computed deal pricing, cap to limit.
    const byId = new Map(products.map((p) => [p.id, p.toJSON() as any]));
    const out: any[] = [];
    for (const pid of productIds) {
      const p = byId.get(pid);
      if (!p) continue; // not published or not stocked at this shop
      const d = bestByProduct.get(pid)!;
      const { price, mrp } = this.effectivePrice(p);
      const priceAfter = this.applyDiscount(price, d.discountType, Number(d.discountValue));
      p.deal = {
        id: d.id,
        discountType: d.discountType,
        discountValue: Number(d.discountValue),
        priceBefore: price,
        priceAfter,
        mrp,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        priority: d.priority,
      };
      p.availability = availabilityOf(p.variants);
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }
}
