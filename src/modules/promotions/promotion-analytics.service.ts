import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { QueryTypes } from "sequelize";
import { Promotion } from "@/models";

/**
 * Promotion Analytics (plan Phase A — read-only, no schema change). Computes performance
 * metrics entirely from data already persisted: `orders.promotionSnapshot`
 * (appliedPromotions[] + rewards[]) and `order_items` (isFree/promotionId/quantity/shopId).
 *
 * Attribution notes:
 *  - "applied" = the promotion id appears in `promotionSnapshot.appliedPromotions` (i.e. it
 *     survived stacking and took effect on that order).
 *  - Reward savings are exact per-promotion (each reward line carries its `promotionId` +
 *     original price). Line-discount savings (flash/festival/category/cart) are taken from
 *     the order's aggregate `promotionLineDiscount`; when a single line-promo applied to an
 *     order this is exact, and with the best-value-wins stacking rule that is the norm.
 *
 * Phase B swaps these scans for the indexed `promotion_redemptions` table where available.
 */
@Injectable()
export class PromotionAnalyticsService {
  constructor(
    @InjectConnection() private sequelize: Sequelize,
    @InjectModel(Promotion) private promotion: typeof Promotion,
  ) {}

  private LINE_TYPES = ["flash", "festival", "category", "cart", "auto"];

  private async q<T = any>(sql: string, replacements: Record<string, any>): Promise<T[]> {
    return this.sequelize.query(sql, { replacements, type: QueryTypes.SELECT }) as Promise<T[]>;
  }

  /* ───────────────────────── Per-promotion ───────────────────────── */
  async promotionAnalytics(id: string) {
    const promo = await this.promotion.findByPk(id);
    if (!promo) throw new NotFoundException("NOT_FOUND", "Promotion not found");

    // Headline metrics from the indexed redemption ledger (fast; Phase B).
    const [head] = await this.q(
      `SELECT COUNT(*)::int AS "totalOrders",
              COUNT(DISTINCT pr."userId")::int AS "uniqueCustomers",
              COALESCE(SUM(pr."savedAmount"),0)::numeric AS "customerSavings",
              COALESCE(SUM(pr."rewardQuantity"),0)::int AS "rewardQuantity",
              COALESCE(SUM(o.total),0)::numeric AS "revenueInfluenced"
       FROM promotion_redemptions pr
       JOIN orders o ON o.id = pr."orderId" AND o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed')
       WHERE pr."promotionId" = :id`,
      { id },
    );

    // Reward products distributed (grouped by variant, with product title).
    const rewardProducts = await this.q(
      `SELECT r->>'variantId' AS "variantId",
              COALESCE(p.title, r->>'productName') AS "productName",
              SUM((r->>'quantity')::numeric)::numeric AS quantity,
              SUM(((r->>'unitPriceBefore')::numeric - (r->>'unitPrice')::numeric) * (r->>'quantity')::numeric)::numeric AS savings
       FROM orders o, LATERAL jsonb_array_elements(COALESCE(o."promotionSnapshot"->'rewards','[]'::jsonb)) r
       LEFT JOIN product_variants v ON v.id = (r->>'variantId')::uuid
       LEFT JOIN products p ON p.id = v."productId"
       WHERE o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed') AND r->>'promotionId' = :id
       GROUP BY 1, 2 ORDER BY quantity DESC`,
      { id },
    );

    // Shop-wise performance (orders + free units per serving shop).
    const shopBreakdown = await this.q(
      `SELECT s."shopId", sh.name AS "shopName",
              COUNT(DISTINCT o.id)::int AS orders,
              COALESCE(SUM(CASE WHEN oi."promotionId" = :id AND oi."isFree" THEN oi.quantity ELSE 0 END),0)::int AS "freeUnits"
       FROM promotion_redemptions pr
       JOIN orders o ON o.id = pr."orderId" AND o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed')
       JOIN order_shipments s ON s."orderId" = o.id
       LEFT JOIN order_items oi ON oi."shipmentId" = s.id
       LEFT JOIN shops sh ON sh.id = s."shopId"
       WHERE pr."promotionId" = :id
       GROUP BY s."shopId", sh.name ORDER BY orders DESC`,
      { id },
    );

    // Customer usage history (from the ledger).
    const customerUsage = await this.q(
      `SELECT pr."userId", u.name, u.email,
              COUNT(*)::int AS "orderCount",
              COALESCE(SUM(o.total),0)::numeric AS "revenue"
       FROM promotion_redemptions pr
       JOIN orders o ON o.id = pr."orderId" AND o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed')
       LEFT JOIN users u ON u.id = pr."userId"
       WHERE pr."promotionId" = :id
       GROUP BY pr."userId", u.name, u.email ORDER BY "orderCount" DESC LIMIT 50`,
      { id },
    );

    // Recent orders (from the ledger).
    const recentOrders = await this.q(
      `SELECT o.id, o."orderNumber", o.total, o.status, o."createdAt", u.name AS "customerName"
       FROM promotion_redemptions pr
       JOIN orders o ON o.id = pr."orderId" AND o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed')
       LEFT JOIN users u ON u.id = o."userId"
       WHERE pr."promotionId" = :id
       ORDER BY o."createdAt" DESC LIMIT 10`,
      { id },
    );

    // Split the ledger's combined savings into reward vs line for display.
    const customerSavings = Number(head?.customerSavings || 0);
    const rewardSavings = rewardProducts.reduce((s: number, r: any) => s + Number(r.savings || 0), 0);
    const lineSavings = Math.max(0, customerSavings - rewardSavings);

    return {
      promotion: {
        id: promo.id, name: promo.name, type: promo.type, status: promo.status,
        isActive: promo.isActive, startsAt: promo.startsAt, endsAt: promo.endsAt,
        discountKind: promo.discountKind, discountValue: promo.discountValue, rewardRule: promo.rewardRule,
      },
      kpis: {
        timesApplied: Number(head?.totalOrders || 0),
        totalOrders: Number(head?.totalOrders || 0),
        uniqueCustomers: Number(head?.uniqueCustomers || 0),
        freeProductsDistributed: Number(head?.rewardQuantity || 0),
        rewardQuantity: Number(head?.rewardQuantity || 0),
        customerSavings,
        rewardSavings,
        lineSavings,
        revenueInfluenced: Number(head?.revenueInfluenced || 0),
      },
      rewardProducts,
      shopBreakdown,
      customerUsage,
      recentOrders,
    };
  }

  /* ───────────────────────── Summary dashboard ───────────────────────── */
  async summary() {
    const now = new Date().toISOString();

    const [active] = await this.q(
      `SELECT COUNT(*)::int AS n FROM promotions
       WHERE "deletedAt" IS NULL AND "isActive" = true AND status = 'active'
         AND ("startsAt" IS NULL OR "startsAt" <= :now)
         AND ("endsAt" IS NULL OR "endsAt" >= :now)`,
      { now },
    );

    // Redemption totals from the indexed ledger (Phase B).
    const [tot] = await this.q(
      `SELECT COUNT(*)::int AS "totalRedemptions",
              COALESCE(SUM(pr."savedAmount"),0)::numeric AS "totalSavings",
              COALESCE(SUM(pr."rewardQuantity"),0)::int AS "freeProducts"
       FROM promotion_redemptions pr
       JOIN orders o ON o.id = pr."orderId" AND o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed')`,
      {},
    );

    // Revenue influenced — distinct promo orders (the ledger has a row per promotion).
    const [rev] = await this.q(
      `SELECT COALESCE(SUM(o.total),0)::numeric AS "revenueInfluenced"
       FROM orders o
       WHERE o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed') AND o.id IN (SELECT DISTINCT "orderId" FROM promotion_redemptions)`,
      {},
    );

    // Top performing promotions (by orders redeemed), from the ledger.
    const topPromotions = await this.q(
      `SELECT pr."promotionId" AS id, COALESCE(p.name, 'Promotion') AS name, p.type,
              COUNT(*)::int AS orders,
              COALESCE(SUM(pr."savedAmount"),0)::numeric AS savings
       FROM promotion_redemptions pr
       JOIN orders o ON o.id = pr."orderId" AND o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed')
       LEFT JOIN promotions p ON p.id = pr."promotionId"
       GROUP BY pr."promotionId", p.name, p.type
       ORDER BY orders DESC, savings DESC LIMIT 10`,
      {},
    );

    // Top reward products across all promotions.
    const topRewardProducts = await this.q(
      `SELECT r->>'variantId' AS "variantId",
              COALESCE(p.title, r->>'productName') AS "productName",
              SUM((r->>'quantity')::numeric)::numeric AS quantity
       FROM orders o, LATERAL jsonb_array_elements(
              COALESCE(o."promotionSnapshot"->'rewards', o."bogoSnapshot"->'rewards', '[]'::jsonb)) r
       LEFT JOIN product_variants v ON v.id = (r->>'variantId')::uuid
       LEFT JOIN products p ON p.id = v."productId"
       WHERE o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed')
       GROUP BY 1,2 ORDER BY quantity DESC LIMIT 10`,
      {},
    );

    // Daily trend (last 30 days) — promo orders + savings.
    const trend = await this.q(
      `SELECT to_char(date_trunc('day', o."createdAt"), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS orders,
              COALESCE(SUM((o."promotionSnapshot"->>'promotionLineDiscount')::numeric),0)::numeric AS "lineSavings"
       FROM orders o
       WHERE o."deletedAt" IS NULL AND o.status NOT IN ('cancelled','refunded','returned','failed')
         AND o."createdAt" >= (CURRENT_DATE - INTERVAL '30 days')
         AND jsonb_array_length(COALESCE(o."promotionSnapshot"->'appliedPromotions','[]'::jsonb)) > 0
       GROUP BY 1 ORDER BY 1`,
      {},
    );

    return {
      kpis: {
        activePromotions: Number(active?.n || 0),
        totalRedemptions: Number(tot?.totalRedemptions || 0),
        totalCustomerSavings: Number(tot?.totalSavings || 0),
        totalFreeProducts: Number(tot?.freeProducts || 0),
        revenueInfluenced: Number(rev?.revenueInfluenced || 0),
      },
      topPromotions,
      topRewardProducts,
      trend,
    };
  }
}
