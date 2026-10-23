import { Controller, Get, Module, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiQuery, ApiTags } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { Sequelize, Op, QueryTypes } from "sequelize";
import {
  Order, OrderItem, OrderShipment, SearchQuery, Shop, User,
  Product, ProductVariant, ShopInventory, Return, NotificationAuditLog, NotificationInbox, Setting
} from "@/models";
import { OrderStatus } from "@/common/enums/order-status.enum";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { Role } from "@/common/enums/role.enum";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { assertPlatformScope } from "@/common/utils/permission.util";

/** Statuses that represent a genuinely fulfilled sale. */
const FULFILLED_STATUSES = [OrderStatus.DELIVERED, OrderStatus.COMPLETED];

/** Statuses that are excluded from any sales calculation (non-revenue). */
const EXCLUDED_STATUSES = [
  OrderStatus.CANCELLED,
  OrderStatus.RETURN_REQUESTED,
  OrderStatus.RETURN_APPROVED,
  OrderStatus.RETURNED,
  OrderStatus.REFUND_PENDING,
  OrderStatus.REFUNDED,
  OrderStatus.FAILED,
  OrderStatus.PAYMENT_PENDING, // online order never paid
];

/** Approved return status string on the returns table. */
const APPROVED_RETURN_STATUS = "approved";

/** In-process cache entry type. */
interface BestsellerCacheEntry {
  data: any;
  cachedAt: number;
}

@ApiTags("Analytics")
@ApiBearerAuth()
@RequirePermissions("analytics.view")
@Controller("analytics")
export class AnalyticsController {
  /** Simple in-process cache keyed by a deterministic cache key string. */
  private readonly _bsCache = new Map<string, BestsellerCacheEntry>();
  private readonly _bsCacheTtlMs = 5 * 60 * 1000; // 5 minutes

  constructor(
    @InjectModel(Order) private order: typeof Order,
    @InjectModel(OrderItem) private item: typeof OrderItem,
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(Shop) private shop: typeof Shop,
    @InjectModel(User) private user: typeof User,
    @InjectModel(SearchQuery) private query: typeof SearchQuery,
    @InjectModel(Product) private product: typeof Product,
    @InjectModel(ProductVariant) private variant: typeof ProductVariant,
    @InjectModel(ShopInventory) private inventory: typeof ShopInventory,
    @InjectModel(Return) private returnModel: typeof Return,
    @InjectModel(Setting) private settingModel: typeof Setting,
    @InjectModel(NotificationAuditLog) private notifAudit: typeof NotificationAuditLog,
    @InjectModel(NotificationInbox) private notifInbox: typeof NotificationInbox,
  ) {}

  private managerShop(u: JwtPayload): string | null {
    return u.role === Role.SHOP_MANAGER ? (u.shopId ?? null) : null;
  }

  /**
   * A shop's sales revenue: its order lines whose shipment was not cancelled,
   * failed, refunded or left unpaid. Summed in SQL — this used to load every
   * matching order line into memory and add them up in JS, per request (and
   * once per shop on the comparison view).
   */
  private async shopSaleRevenue(shopId: string): Promise<number> {
    const [row] = await this.item.sequelize!.query<{ revenue: number }>(
      `SELECT COALESCE(SUM(oi.price * oi.quantity), 0)::float8 AS revenue
         FROM order_items oi JOIN order_shipments s ON s.id = oi."shipmentId"
        WHERE oi."shopId" = :shopId AND s.status NOT IN (:excluded)`,
      { type: QueryTypes.SELECT, replacements: { shopId, excluded: EXCLUDED_STATUSES } },
    );
    return Number(row?.revenue ?? 0);
  }

  /** Platform revenue: order totals, excluding orders that never became a sale. */
  private platformRevenue() {
    return this.order.sum("total", { where: { status: { [Op.notIn]: EXCLUDED_STATUSES } } }).then((v) => v ?? 0);
  }

  @Get("overview") async overview(@CurrentUser() u: JwtPayload) {
    const shopId = this.managerShop(u);
    if (shopId) {
      // Shop-scoped figures for a shop manager.
      const revenue = await this.shopSaleRevenue(shopId);
      const [counts] = await this.item.sequelize!.query<{ orders: number; customers: number }>(
        `SELECT COUNT(DISTINCT s."orderId")::int AS orders, COUNT(DISTINCT o."userId")::int AS customers
           FROM order_shipments s JOIN orders o ON o.id = s."orderId" WHERE s."shopId" = :shopId`,
        { type: QueryTypes.SELECT, replacements: { shopId } },
      );
      return { revenue, totalOrders: Number(counts?.orders ?? 0), customers: Number(counts?.customers ?? 0), activeShops: 1, scope: "shop" };
    }
    const [revenue, totalOrders, customers, activeShops] = await Promise.all([
      this.platformRevenue(),
      this.order.count(),
      this.user.count({ where: { role: "customer" as any } }),
      this.shop.count({ where: { isActive: true } }),
    ]);
    return { revenue, totalOrders, customers, activeShops, scope: "platform" };
  }

  @Get("revenue") async revenue(@CurrentUser() u: JwtPayload) {
    const shopId = this.managerShop(u);
    if (shopId) {
      return { total: await this.shopSaleRevenue(shopId), scope: "shop" };
    }
    return { total: await this.platformRevenue(), scope: "platform" };
  }

  /**
   * Revenue bucketed by calendar month for the trailing `months` window.
   * Backs the dashboard revenue chart, which needs a series rather than the
   * single total `GET /analytics/revenue` returns. Months with no orders are
   * emitted as zero so the line stays continuous instead of skipping gaps.
   */
  @ApiQuery({ name: "months", required: false })
  @Get("revenue/monthly") async revenueMonthly(
    @CurrentUser() u: JwtPayload,
    @Query("months") monthsRaw?: string,
  ) {
    const months = Math.min(Math.max(Number(monthsRaw) || 12, 1), 24);
    const shopId = this.managerShop(u);

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(1);
    since.setUTCMonth(since.getUTCMonth() - (months - 1));

    const buckets = new Map<string, number>();
    for (let i = 0; i < months; i++) {
      const d = new Date(since);
      d.setUTCMonth(since.getUTCMonth() + i);
      buckets.set(d.toISOString().slice(0, 7), 0);
    }

    // Bucketed in SQL by UTC calendar month; rows used to be loaded whole and
    // summed in JS. Shop scope: the shop's own order lines, not the order
    // total, which may span several shops.
    const seq = this.item.sequelize!;
    const rows = shopId
      ? await seq.query<{ m: string; v: number }>(
          `SELECT to_char(o."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM') AS m, SUM(oi.price * oi.quantity)::float8 AS v
             FROM order_items oi
             JOIN order_shipments s ON s.id = oi."shipmentId"
             JOIN orders o ON o.id = s."orderId"
            WHERE oi."shopId" = :shopId AND o.status NOT IN (:excluded) AND o."createdAt" >= :since
            GROUP BY 1`,
          { type: QueryTypes.SELECT, replacements: { shopId, excluded: EXCLUDED_STATUSES, since } },
        )
      : await seq.query<{ m: string; v: number }>(
          `SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM') AS m, SUM(total)::float8 AS v
             FROM orders WHERE status NOT IN (:excluded) AND "createdAt" >= :since GROUP BY 1`,
          { type: QueryTypes.SELECT, replacements: { excluded: EXCLUDED_STATUSES, since } },
        );
    for (const r of rows) if (buckets.has(r.m)) buckets.set(r.m, buckets.get(r.m)! + Number(r.v));

    const series = [...buckets.entries()].map(([month, value]) => ({
      month: new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      period: month,
      value: Math.round(value),
    }));

    return { series, scope: shopId ? "shop" : "platform" };
  }

  @Get("orders/by-status") async byStatus(@CurrentUser() u: JwtPayload) {
    const shopId = this.managerShop(u);
    const statuses = Object.values(OrderStatus);
    // One GROUP BY instead of one COUNT per status.
    const rows = (shopId
      ? await this.ship.findAll({ where: { shopId }, attributes: ["status", [Sequelize.fn("COUNT", Sequelize.col("id")), "n"]], group: ["status"], raw: true })
      : await this.order.findAll({ attributes: ["status", [Sequelize.fn("COUNT", Sequelize.col("id")), "n"]], group: ["status"], raw: true })) as any[];
    const byStatus = new Map(rows.map((r) => [r.status, Number(r.n)]));
    return statuses.map((s) => ({ status: s, count: byStatus.get(s) ?? 0 }));
  }

  @Get("shops/compare") async compare(@CurrentUser() u: JwtPayload) {
    const shopId = this.managerShop(u);
    const shops = shopId ? await this.shop.findAll({ where: { id: shopId } }) : await this.shop.findAll();
    return Promise.all(shops.map(async (s) => {
      const revenue = await this.shopSaleRevenue(s.id);
      const shipmentsCount = await this.ship.count({ where: { shopId: s.id } });
      return {
        shopId: s.id,
        shopName: s.name,
        totalOrders: shipmentsCount,
        revenue,
      };
    }));
  }

  @Get("search/top") async topSearch(@CurrentUser() u: JwtPayload) {
    // Every shopper's search terms, platform-wide: not for shop accounts.
    assertPlatformScope(u);
    const queries = await this.query.findAll({
      attributes: [
        "query",
        [Sequelize.fn("COUNT", Sequelize.col("id")), "count"]
      ],
      group: ["query"],
      order: [[Sequelize.literal("count"), "DESC"]],
      limit: 20
    });
    return queries.map((q: any) => ({
      term: q.getDataValue("query"),
      count: parseInt(q.getDataValue("count")) || 0
    }));
  }

  @Get("heat-map") async heatMap(@CurrentUser() u: JwtPayload) {
    const shopId = this.managerShop(u);
    const shops = shopId
      ? await this.shop.findAll({ where: { id: shopId }, attributes: ["id", "name", "lat", "lng"] })
      : await this.shop.findAll({ attributes: ["id", "name", "lat", "lng"] });
    return Promise.all(shops.map(async (s) => ({ ...s.toJSON(), shipments: await this.ship.count({ where: { shopId: s.id } }) })));
  }

  @Get("notifications") async notificationStats(@CurrentUser() u: JwtPayload) {
    assertPlatformScope(u);
    // Basic stats for the dashboard
    const sent = await this.notifAudit.count({ where: { status: "sent" } });
    const delivered = await this.notifAudit.count({ where: { status: "delivered" } });
    const opened = await this.notifAudit.count({ where: { status: "opened" } });
    const clicked = await this.notifAudit.count({ where: { status: "clicked" } });
    const failed = await this.notifAudit.count({ where: { status: "failed" } });

    const openRate = delivered > 0 ? ((opened / delivered) * 100).toFixed(2) : 0;
    const clickRate = opened > 0 ? ((clicked / opened) * 100).toFixed(2) : 0;

    const channelStats = await this.notifAudit.findAll({
      attributes: ["channel", [Sequelize.fn("COUNT", Sequelize.col("id")), "count"]],
      group: ["channel"],
      raw: true,
    });

    return {
      sent,
      delivered,
      opened,
      clicked,
      failed,
      openRate,
      clickRate,
      channelStats
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * GET /analytics/bestsellers
   *
   * Query params:
   *   metric   : "units" | "revenue" | "profit" | "stock"   (default: "units")
   *   period   : "day" | "week" | "month" | "year" | "all"  (default: "month")
   *   limit    : 1–50                                       (default: 10)
   *   page     : >=1                                        (default: 1)
   *
   * Business rules (Source of Truth):
   *   - Only order_items whose parent shipment status is DELIVERED or COMPLETED
   *     are counted as fulfilled sales.
   *   - Net Units = Gross Units Sold − Approved Return Quantities for that item.
   *   - Revenue uses the price snapshot stored on order_items at checkout time
   *     (order_items.unitPrice or order_items.price), not the current variant price.
   *   - Profit = Revenue × 0.30 (30% margin fallback; no costPrice column exists).
   *   - Role scoping: Shop Manager → restricted to their shopId; Admin → global.
   *   - Results are cached in-process for 5 minutes per unique query signature.
   * ─────────────────────────────────────────────────────────────────────────
   */
  @ApiQuery({ name: "metric", required: false, enum: ["units", "revenue", "profit", "stock"] })
  @ApiQuery({ name: "period", required: false, enum: ["day", "week", "month", "year", "all"] })
  @ApiQuery({ name: "limit",  required: false, type: Number })
  @ApiQuery({ name: "page",   required: false, type: Number })
  @Get("bestsellers")
  async bestsellers(
    @CurrentUser() u: JwtPayload,
    @Query("metric") metric = "units",
    @Query("period") period = "month",
    @Query("limit")  limitStr = "10",
    @Query("page")   pageStr  = "1",
  ) {
    const scopedShopId = this.managerShop(u);
    const limit = Math.min(Math.max(parseInt(limitStr) || 10, 1), 50);
    // Every one of these reaches the cache key, so each is pinned to a known
    // value: free text and an unbounded page used to mint a new key per request.
    const page  = Math.min(Math.max(parseInt(pageStr) || 1, 1), 1_000);
    const offset = (page - 1) * limit;
    if (!["units", "revenue", "profit", "stock"].includes(metric)) metric = "units";
    if (!["day", "week", "month", "year", "all"].includes(period)) period = "month";

    // ── Cache key ──────────────────────────────────────────────────────────
    const cacheKey = `bs:${scopedShopId ?? "global"}:${metric}:${period}:${limit}:${page}`;
    const cached = this._bsCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this._bsCacheTtlMs) {
      return cached.data;
    }

    // ── Date window ────────────────────────────────────────────────────────
    const sinceDate = this._periodToDate(period);

    /*
     * Steps 1-3 run in the database. They used to load every fulfilled
     * shipment id, then every order-item id, then every refunded return into
     * the API's memory and add them up in JS — on every uncached request, over
     * the whole sales history for period=all. One subquery names the
     * fulfilled shipments; both sums are GROUP BYs over it.
     */
    const seq = this.item.sequelize!;
    const fulfilledSql =
      `SELECT s.id FROM order_shipments s WHERE s.status IN (${FULFILLED_STATUSES.map((x) => seq.escape(x)).join(", ")})` +
      (scopedShopId ? ` AND s."shopId" = ${seq.escape(scopedShopId)}` : "") +
      (sinceDate ? ` AND s."deliveredAt" >= ${seq.escape(sinceDate.toISOString())}` : "");

    // ── Step 2: Aggregate order_items for those shipments ──────────────────
    const itemWhere: any = { shipmentId: { [Op.in]: Sequelize.literal(`(${fulfilledSql})`) } };
    if (scopedShopId) itemWhere.shopId = scopedShopId;

    // Raw aggregation — ONE row per product (aggregate across all its variants).
    // Grouping also by name/image/sku previously split a multi-variant product
    // into several rows, so the same product appeared multiple times.
    const rawRows = await this.item.findAll({
      where: itemWhere,
      attributes: [
        "productId",
        [Sequelize.fn("MAX", Sequelize.col("productName")), "productName"],
        [Sequelize.fn("MAX", Sequelize.col("productImage")), "productImage"],
        [Sequelize.fn("MAX", Sequelize.col("sku")), "sku"],
        [Sequelize.fn("SUM", Sequelize.col("quantity")), "grossUnits"],
        [
          Sequelize.fn(
            "SUM",
            Sequelize.literal(`COALESCE("unitPrice", "price", 0) * "quantity"`)
          ),
          "grossRevenue",
        ],
        [Sequelize.fn("COUNT", Sequelize.fn("DISTINCT", Sequelize.col("shipmentId"))), "orderCount"],
      ],
      group: ["productId"],
      raw: true,
    }) as any[];

    if (!rawRows.length) {
      return this._buildEmptyResponse(page, limit);
    }

    // ── Step 3: Subtract refunded returns (per product, in SQL) ────────────
    // Only REFUNDED returns are a completed sale reversal, counted in the
    // actually returned units (Return.quantity — partial returns), falling
    // back to the whole line when quantity is null.
    const returnedRows = await seq.query<{ productId: string; units: string }>(
      `SELECT oi."productId", SUM(COALESCE(r.quantity, oi.quantity)) AS units
         FROM returns r
         JOIN order_items oi ON oi.id = r."orderItemId"
        WHERE r.status = 'refunded' AND oi."shipmentId" IN (${fulfilledSql})` +
        (scopedShopId ? ` AND oi."shopId" = ${seq.escape(scopedShopId)}` : "") +
      ` GROUP BY oi."productId"`,
      { type: QueryTypes.SELECT },
    );
    const returnedUnitsByProduct = new Map<string, number>(returnedRows.map((r) => [r.productId, Number(r.units) || 0]));

    // ── Step 4: Current stock — sum active inventory across ALL variants of ──
    // each product (previously only one arbitrary variant was counted), scoped
    // to the manager's shop when applicable.
    const productIds = rawRows.map((r: any) => r.productId).filter(Boolean);
    const prodVariants = productIds.length
      ? await this.variant.findAll({
          where: { productId: { [Op.in]: productIds } },
          attributes: ["id", "productId"],
          raw: true,
        }) as any[]
      : [];

    const variantToProduct = new Map<string, string>();
    const firstVariantOfProduct = new Map<string, string>();
    for (const v of prodVariants) {
      variantToProduct.set(v.id, v.productId);
      if (!firstVariantOfProduct.has(v.productId)) firstVariantOfProduct.set(v.productId, v.id);
    }

    const invWhere: any = { variantId: { [Op.in]: prodVariants.map((v: any) => v.id) }, isActive: true };
    if (scopedShopId) invWhere.shopId = scopedShopId;
    const inventoryRows = prodVariants.length
      ? await this.inventory.findAll({ where: invWhere, attributes: ["variantId", "quantity"], raw: true }) as any[]
      : [];

    const stockByProduct = new Map<string, number>();
    for (const inv of inventoryRows) {
      const pid = variantToProduct.get(inv.variantId);
      if (!pid) continue;
      stockByProduct.set(pid, (stockByProduct.get(pid) ?? 0) + (Number(inv.quantity) || 0));
    }

    // Real platform finance rates (same Settings keys the settlement engine uses)
    // — replaces the hardcoded 0.30 profit margin.
    const [commissionRate, gatewayRate, taxRate] = await this._financeRates();

    // ── Step 5: Build result rows ──────────────────────────────────────────
    const rows = rawRows.map((r: any) => {
      const grossUnits   = parseInt(r.grossUnits)   || 0;
      const grossRevenue = parseFloat(r.grossRevenue) || 0;
      const returnedUnits = returnedUnitsByProduct.get(r.productId) ?? 0;

      const netUnits   = Math.max(grossUnits - returnedUnits, 0);
      const netRevenue = grossRevenue > 0
        ? grossRevenue * (netUnits / Math.max(grossUnits, 1))
        : 0;
      // Contribution after real platform fees (commission + gateway + tax), the
      // same deductions the settlement engine applies. No cost/COGS column exists
      // in the schema, so true gross margin isn't computable — this is the honest
      // money-based figure. NOTE: with uniform %, Profit ranking tracks Revenue.
      const netProfit = Math.max(netRevenue * (1 - commissionRate - gatewayRate - taxRate), 0);

      const currentStock = stockByProduct.get(r.productId) ?? 0;

      // Stock coverage in days (avoid division by zero)
      const daysMap: Record<string, number> = { day: 1, week: 7, month: 30, year: 365, all: 365 };
      const periodDays = daysMap[period] || 30;
      const dailyVelocity = netUnits / periodDays;
      const stockCoverageDays = dailyVelocity > 0
        ? Math.round(currentStock / dailyVelocity)
        : null;

      // Stock health badge
      let stockHealth: "ok" | "low" | "critical" | "out" = "ok";
      if (currentStock === 0) stockHealth = "out";
      else if (currentStock <= 5) stockHealth = "critical";
      else if (currentStock <= 20) stockHealth = "low";

      return {
        productId    : r.productId,
        productName  : r.productName ?? "Unknown Product",
        productImage : r.productImage ?? null,
        sku          : r.sku ?? null,
        variantId    : firstVariantOfProduct.get(r.productId) ?? null,
        netUnitsSold : netUnits,
        grossUnitsSold: grossUnits,
        returnedUnits,
        netRevenue   : +netRevenue.toFixed(2),
        netProfit    : +netProfit.toFixed(2),
        orderCount   : parseInt(r.orderCount) || 0,
        currentStock,
        stockCoverageDays,
        stockHealth,
      };
    });

    // ── Step 6: Sort by selected metric ───────────────────────────────────
    const sorted = rows.sort((a, b) => {
      switch (metric) {
        case "revenue": return b.netRevenue   - a.netRevenue;
        case "profit":  return b.netProfit    - a.netProfit;
        case "stock":   return b.currentStock - a.currentStock;
        case "units":
        default:        return b.netUnitsSold - a.netUnitsSold;
      }
    });

    // ── Step 7: Paginate ───────────────────────────────────────────────────
    const totalItems = sorted.length;
    const totalPages = Math.ceil(totalItems / limit);
    const paged = sorted.slice(offset, offset + limit).map((r, i) => ({
      rank: offset + i + 1,
      ...r,
    }));

    const result = {
      items: paged,
      meta: {
        page,
        limit,
        totalItems,
        totalPages,
        hasPrev : page > 1,
        hasNext : page < totalPages,
      },
      filters: { metric, period, scope: scopedShopId ? "shop" : "platform" },
      cachedAt: new Date().toISOString(),
    };

    // ── Cache & return ─────────────────────────────────────────────────────
    this._bsCache.set(cacheKey, { data: result, cachedAt: Date.now() });
    // Bounded: oldest entries go first once the map is full.
    while (this._bsCache.size > 500) this._bsCache.delete(this._bsCache.keys().next().value as string);
    return result;
  }

  /** Real platform fee rates from Settings (fallbacks mirror the finance module). */
  private async _financeRates(): Promise<[number, number, number]> {
    const [c, g, t] = await Promise.all([
      this.settingModel.findOne({ where: { key: "platform.commission.rate" } }),
      this.settingModel.findOne({ where: { key: "gateway.fee.rate" } }),
      this.settingModel.findOne({ where: { key: "tax.rate" } }),
    ]);
    return [
      c ? Number(c.value) : 0.05,
      g ? Number(g.value) : 0.02,
      t ? Number(t.value) : 0.18,
    ];
  }

  /** Convert a period string to a UTC Date (start of window) or null for "all". */
  private _periodToDate(period: string): Date | null {
    const now = new Date();
    switch (period) {
      case "day":   return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      case "week":  { const d = new Date(now); d.setUTCDate(d.getUTCDate() - 7); return d; }
      case "month": { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - 1); return d; }
      case "year":  { const d = new Date(now); d.setUTCFullYear(d.getUTCFullYear() - 1); return d; }
      case "all":
      default:       return null;
    }
  }

  private _buildEmptyResponse(page: number, limit: number) {
    return {
      items: [],
      meta: { page, limit, totalItems: 0, totalPages: 0, hasPrev: false, hasNext: false },
      filters: {},
      cachedAt: new Date().toISOString(),
    };
  }
}

@Module({
  imports: [
    SequelizeModule.forFeature([
      Order, OrderItem, OrderShipment, Shop, User, SearchQuery,
      Product, ProductVariant, ShopInventory, Return, NotificationAuditLog, NotificationInbox, Setting
    ]),
  ],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
