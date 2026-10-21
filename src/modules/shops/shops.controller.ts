import { Body, Controller, Get, Param, Patch, Post, Query, Delete, Headers } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { env } from "@/config/env";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { Op, Transaction } from "sequelize";
import {
  Shop, User, AuditLog, Order, OrderShipment, OrderItem,
  ShopInventory, StockMovement, ProductVariant, Product,
  Category, PaymentRefund, Payment, Return
} from "@/models";
import { Public } from "@/common/decorators/public.decorator";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { Role } from "@/common/enums/role.enum";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate, findOr404 } from "@/common/utils/crud.util";
import { ShopDto, InterShopTransferDto, NewShopManagerDto } from "@/common/dto/common.dto";
import { hashPassword } from "@/common/utils/password.util";
import { StockTransferService } from "@/modules/inventory/stock-transfer.service";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { BadRequestException, ConflictException, NotFoundException } from "@/common/errors/http";
import { OrderStatus } from "@/common/enums/order-status.enum";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { haversineKm } from "@/common/utils/geo.util";
import { geocodingProvider } from "@/common/providers/geocoding.provider";

/** Roles that see a shop's full row and its live metrics. */
const STAFF_ROLES = new Set<string>([Role.ADMIN, Role.SHOP_MANAGER, Role.OPERATIONS, Role.FINANCE, Role.MARKETING, Role.SUPPORT]);

/**
 * What a signed-out visitor (or a customer) sees of a shop: where it is, how
 * to reach it, when it is open and how far it delivers. Never the manager,
 * the revenue or the fulfilment figures.
 */
function publicShop(row: any) {
  const s = typeof row?.toJSON === "function" ? row.toJSON() : row;
  return {
    id: s.id, name: s.name, address: s.address, city: s.city, state: s.state, country: s.country,
    postalCode: s.postalCode, lat: s.lat, lng: s.lng, phone: s.phone, email: s.email,
    isActive: s.isActive, pickupEnabled: s.pickupEnabled, openingTime: s.openingTime, closingTime: s.closingTime,
    deliveryRadiusKm: s.deliveryRadiusKm,
  };
}

@ApiTags("Shops")
@RequirePermissions('shops.view')
@Controller("shops")
export class ShopsController {
  constructor(
    @InjectModel(Shop) private shop: typeof Shop,
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    @InjectModel(Order) private orderModel: typeof Order,
    @InjectModel(OrderShipment) private orderShipmentModel: typeof OrderShipment,
    @InjectModel(OrderItem) private orderItemModel: typeof OrderItem,
    @InjectModel(ShopInventory) private shopInventoryModel: typeof ShopInventory,
    @InjectModel(StockMovement) private stockMovementModel: typeof StockMovement,
    @InjectModel(ProductVariant) private productVariantModel: typeof ProductVariant,
    @InjectModel(PaymentRefund) private paymentRefundModel: typeof PaymentRefund,
    @InjectModel(Return) private returnModel: typeof Return,
    @InjectConnection() private sequelize: Sequelize,
    private eventEmitter: EventEmitter2,
    private stockTransfer: StockTransferService,
  ) {}

  /**
   * Public — the storefront reads it for the serving-shop badge — but the
   * full rows and live metrics only go to signed-in staff. Every dashboard
   * screen calls this with its token; anyone else gets `publicShop`.
   */
  @Public()
  @Get()
  async list(@Query() opts: PageOptionsDto, @Headers("authorization") authorization?: string) {
    const page = await paginate(this.shop, opts);
    if (!(await this.isStaff(authorization))) {
      page.items = page.items.map(publicShop);
      return page;
    }
    page.items = await this.attachShopMetrics(page.items);
    return page;
  }

  /**
   * Whether a public route's caller is signed-in staff. Public routes skip the
   * JWT guard, so the token is checked here: valid signature, active account,
   * current token version (the same tests JwtStrategy applies), staff role.
   * Anything short of that is treated as anonymous rather than refused.
   */
  private async isStaff(authorization?: string): Promise<boolean> {
    const [scheme, token] = (authorization ?? "").split(" ");
    if (scheme !== "Bearer" || !token) return false;
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
      const user = await this.userModel.findByPk(payload.sub, { attributes: ["id", "role", "isActive", "tokenVersion"] });
      return !!user && user.isActive && (payload.tv ?? 0) === user.tokenVersion && STAFF_ROLES.has(user.role);
    } catch {
      return false;
    }
  }

  /**
   * Live per-shop KPIs for the Shop Network cards: in-flight orders, net revenue
   * and fulfillment rate. Computed from order_shipments / order_items / returns —
   * there are no stored counters, so the numbers move the moment an order is
   * placed, delivered, cancelled or refunded.
   *
   * Two grouped queries for the whole page (not per shop) to keep this O(1) in
   * round-trips. Definitions deliberately mirror `dashboard/metrics` so a card and
   * the KPI strip above it reconcile:
   *   activeOrderCount — shipments still in flight (placed→out_for_delivery)
   *   fulfillmentRate  — delivered+completed ÷ all shipments, as a percentage
   *   revenue          — Σ order_items (unitPrice ?? price) × qty for THIS shop,
   *                      excluding cancelled/failed orders, minus refunds already
   *                      paid out on this shop's items (net, not gross).
   * Revenue is attributed via order_items.shopId, so a split order credits each
   * shop only for the lines it actually fulfilled.
   */
  private async attachShopMetrics(shops: any[]): Promise<any[]> {
    const items = shops.map((s) => (typeof s?.toJSON === "function" ? s.toJSON() : s));
    const ids = items.map((s) => s.id).filter(Boolean);
    if (!ids.length) return items;

    const idList = ids.map((id) => this.sequelize.escape(id)).join(",");
    const ACTIVE = [OrderStatus.PLACED, OrderStatus.CONFIRMED, OrderStatus.PACKED, OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY];
    const DONE = [OrderStatus.DELIVERED, OrderStatus.COMPLETED];
    const DEAD = [OrderStatus.CANCELLED, OrderStatus.FAILED];
    const list = (v: string[]) => v.map((s) => this.sequelize.escape(s)).join(",");

    const [shipRows, revRows, refundRows]: [any[], any[], any[]] = await Promise.all([
      this.sequelize.query(
        `SELECT "shopId",
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE "status" IN (${list(DONE)}))::int   AS delivered,
                COUNT(*) FILTER (WHERE "status" IN (${list(ACTIVE)}))::int AS active
           FROM "order_shipments"
          WHERE "shopId" IN (${idList})
          GROUP BY "shopId"`,
        { type: "SELECT" as any },
      ) as any,
      this.sequelize.query(
        `SELECT oi."shopId",
                COALESCE(SUM(COALESCE(oi."unitPrice", oi."price") * oi."quantity"), 0)::float AS gross
           FROM "order_items" oi
           JOIN "order_shipments" sh ON sh."id" = oi."shipmentId"
           JOIN "orders" o           ON o."id"  = sh."orderId"
          WHERE oi."shopId" IN (${idList})
            AND o."status" NOT IN (${list(DEAD)})
            AND o."deletedAt" IS NULL
          GROUP BY oi."shopId"`,
        { type: "SELECT" as any },
      ) as any,
      // Refunds are aggregated separately on purpose: joining returns into the
      // revenue query fans out any item with >1 return and double-counts gross.
      this.sequelize.query(
        `SELECT oi."shopId", COALESCE(SUM(r."refundAmount"), 0)::float AS refunded
           FROM "returns" r
           JOIN "order_items" oi ON oi."id" = r."orderItemId"
          WHERE oi."shopId" IN (${idList})
            AND r."status" = 'refunded'
          GROUP BY oi."shopId"`,
        { type: "SELECT" as any },
      ) as any,
    ]);

    const ship = new Map(shipRows.map((r: any) => [r.shopId, r]));
    const rev = new Map(revRows.map((r: any) => [r.shopId, Number(r.gross) || 0]));
    const refunds = new Map(refundRows.map((r: any) => [r.shopId, Number(r.refunded) || 0]));

    return items.map((s) => {
      const sp = ship.get(s.id);
      const total = Number(sp?.total ?? 0);
      return {
        ...s,
        activeOrderCount: Number(sp?.active ?? 0),
        totalOrderCount: total,
        revenue: Math.max(0, (rev.get(s.id) ?? 0) - (refunds.get(s.id) ?? 0)),
        // No shipments yet => nothing has been missed. 100 matches the platform
        // strip's behaviour for an empty network rather than showing a scary 0%.
        fulfillmentRate: total > 0 ? (Number(sp?.delivered ?? 0) / total) * 100 : 100,
      };
    });
  }

  /**
   * Nearest active shop that can deliver to a coordinate. Backs the storefront's
   * delivery-address selector: given the customer's lat/lng it returns the
   * closest serviceable shop so the catalog can be scoped to it.
   *
   * Serviceability reuses the same rule the checkout engine applies — distance
   * (haversine) within the shop's deliveryRadiusKm. Returns { shop: null } when
   * nothing is in range, so the caller can fall back to the full catalog.
   * Declared before any ":id" route so the literal path wins.
   */
  @Public()
  @Get("nearest")
  async nearest(@Query("lat") lat?: string, @Query("lng") lng?: string) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) {
      throw new BadRequestException("VALIDATION_FAILED", "lat and lng are required numbers");
    }

    const shops = await this.shop.findAll({ where: { isActive: true } });
    const serviceable = shops
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ shop: s, distanceKm: haversineKm(la, ln, Number(s.lat), Number(s.lng)) }))
      .filter(({ shop, distanceKm }) => distanceKm <= Number(shop.deliveryRadiusKm ?? 15))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    if (serviceable.length === 0) return { shop: null };

    const { shop, distanceKm } = serviceable[0];
    return {
      shop: {
        id: shop.id,
        name: shop.name,
        city: shop.city ?? null,
        distanceKm: Number(distanceKm.toFixed(2)),
      },
    };
  }

  /**
   * Geocode a free-text address to coordinates (server-side, so it isn't blocked
   * by browser CORS). Backs the auto-seed flow when a default address has no
   * pinned coordinates. Returns { coords: null } on no match. Declared before
   * any ":id" route so the literal path wins.
   */
  @Public()
  @Get("geocode")
  async geocode(@Query("q") q?: string) {
    return { coords: await geocodingProvider.geocode(q ?? "") };
  }

  /**
   * Labelled place suggestions for the "enter location manually" flow (address,
   * city or pincode). Each candidate is annotated with the shop that would serve
   * it, so the picker can show "Delivered by X · 2.4 km" — or grey out an address
   * nothing covers — before the customer commits to it.
   * Declared before any ":id" route so the literal path wins.
   */
  @Public()
  @Get("geocode/search")
  async geocodeSearch(@Query("q") q?: string) {
    const candidates = await geocodingProvider.search(q ?? "");
    if (!candidates.length) return { results: [] };

    const shops = await this.shop.findAll({ where: { isActive: true } });
    const results = candidates.map((c) => {
      const serving = shops
        .filter((s) => s.lat != null && s.lng != null)
        .map((s) => ({ shop: s, distanceKm: haversineKm(c.lat, c.lng, Number(s.lat), Number(s.lng)) }))
        .filter(({ shop, distanceKm }) => distanceKm <= Number(shop.deliveryRadiusKm ?? 15))
        .sort((a, b) => a.distanceKm - b.distanceKm)[0];
      return {
        ...c,
        shop: serving
          ? { id: serving.shop.id, name: serving.shop.name, city: serving.shop.city ?? null, distanceKm: Number(serving.distanceKm.toFixed(2)) }
          : null,
      };
    });
    return { results };
  }

  /**
   * Coordinates → human address, so "Use current location" can show the customer
   * where they are rather than a raw lat/lng.
   */
  @Public()
  @Get("reverse-geocode")
  async reverseGeocode(@Query("lat") lat?: string, @Query("lng") lng?: string) {
    return { address: await geocodingProvider.reverse(Number(lat), Number(lng)) };
  }

  @ApiBearerAuth()
  @Get("dashboard/metrics")
  async getMetrics() {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const liveStatuses = { [Op.notIn]: [OrderStatus.CANCELLED, OrderStatus.FAILED] as any };

    // Twelve independent aggregates. They were awaited one after another, so
    // the dashboard waited for the sum of all twelve round trips instead of the
    // slowest one — and none of them depends on another's result.
    const [
      totalShops,
      activeShops,
      totalOrders,
      pendingOrders,
      deliveredOrders,
      cancelledOrders,
      combinedRevenueRaw,
      totalShipments,
      avgProcessingTimeRaw,
      todayOrders,
      todayRevenueRaw,
      thisMonthRevenueRaw,
    ] = await Promise.all([
      this.shop.count(),
      this.shop.count({ where: { isActive: true } }),
      this.orderModel.count(),
      this.orderShipmentModel.count({
        where: {
          status: { [Op.in]: [OrderStatus.PLACED, OrderStatus.CONFIRMED, OrderStatus.PACKED, OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY] as any }
        }
      }),
      this.orderShipmentModel.count({
        where: {
          status: { [Op.in]: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] as any }
        }
      }),
      this.orderShipmentModel.count({ where: { status: OrderStatus.CANCELLED as any } }),
      this.orderModel.sum("total", { where: { status: liveStatuses } }),
      this.orderShipmentModel.count(),
      this.shop.aggregate("processingTimeMinutes", "AVG"),
      this.orderModel.count({ where: { createdAt: { [Op.gte]: startOfToday } } }),
      this.orderModel.sum("total", {
        where: { createdAt: { [Op.gte]: startOfToday }, status: liveStatuses }
      }),
      this.orderModel.sum("total", {
        where: { createdAt: { [Op.gte]: startOfMonth }, status: liveStatuses }
      }),
    ]);

    const inactiveShops = totalShops - activeShops;
    const combinedRevenue = combinedRevenueRaw ?? 0;
    const todayRevenue = todayRevenueRaw ?? 0;
    const thisMonthRevenue = thisMonthRevenueRaw ?? 0;
    const avgProcessingTime = avgProcessingTimeRaw ?? 120;
    const avgFulfillmentRate = totalShipments > 0 ? (deliveredOrders / totalShipments) * 100 : 100;
    const avgOrderValue = totalOrders > 0 ? Number(combinedRevenue) / totalOrders : 0;

    return {
      totalShops,
      activeShops,
      inactiveShops,
      totalOrders,
      pendingOrders,
      deliveredOrders,
      cancelledOrders,
      combinedRevenue: Number(combinedRevenue),
      avgFulfillmentRate,
      avgProcessingTime,
      todayOrders,
      todayRevenue: Number(todayRevenue),
      thisMonthRevenue: Number(thisMonthRevenue),
      avgOrderValue
    };
  }

  /**
   * Inter-shop stock transfer, backing the "Transfer" action on each Shop card.
   * Delegates to the shared StockTransferService so this and POST
   * /inventory/transfer cannot drift apart (locking, ledger, audit, notifications).
   */
  @ApiBearerAuth()
  @RequirePermissions('shops.edit')
  @Post("transfer")
  async transfer(@CurrentUser() u: JwtPayload, @Body() b: InterShopTransferDto) {
    return this.stockTransfer.transfer(u.sub, b);
  }

  @Public()
  @Get(":id")
  async detail(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    const shop = await findOr404<Shop>(this.shop, id, "Shop");
    return (await this.isStaff(authorization)) ? shop : publicShop(shop);
  }

  @ApiBearerAuth()
  @Get(":id/performance")
  async getPerformance(@Param("id") id: string) {
    const shop = await this.shop.findByPk(id);
    if (!shop) throw new NotFoundException("NOT_FOUND", "Shop not found");

    const lowStockProducts = await this.shopInventoryModel.count({
      where: {
        shopId: id,
        quantity: { [Op.lte]: Sequelize.col("lowStockThreshold") },
        isActive: true
      }
    });

    const outOfStockProducts = await this.shopInventoryModel.count({
      where: {
        shopId: id,
        quantity: 0,
        isActive: true
      }
    });

    const inventoryItems = await this.shopInventoryModel.findAll({
      where: { shopId: id },
      include: [{ model: ProductVariant, as: "variant" }]
    });

    let totalInventoryValue = 0;
    for (const item of inventoryItems) {
      const price = item.priceOverride !== null && item.priceOverride !== undefined
        ? Number(item.priceOverride)
        : (item.variant ? Number(item.variant.defaultPrice) : 0);
      totalInventoryValue += price * item.quantity;
    }

    return {
      lowStockProducts,
      outOfStockProducts,
      totalInventoryValue
    };
  }

  @ApiBearerAuth()
  @Get(":id/analytics")
  async getAnalytics(@Param("id") id: string) {
    const shop = await this.shop.findByPk(id);
    if (!shop) throw new NotFoundException("NOT_FOUND", "Shop not found");

    const items = await this.orderItemModel.findAll({
      where: { shopId: id },
      include: [{
        model: ProductVariant,
        as: "variant",
        include: [{
          model: Product,
          as: "product",
          include: [{ model: Category, as: "category" }]
        }]
      }]
    });

    const productMap: Record<string, { id: string; title: string; qty: number; sales: number }> = {};
    const categoryMap: Record<string, number> = {};

    for (const item of items) {
      const variant = item.variant;
      if (!variant || !variant.product) continue;
      const prodId = variant.product.id;
      const title = variant.product.title;
      const catName = variant.product.category?.name || "Uncategorized";
      const totalCost = Number(item.unitPrice || item.price || 0) * item.quantity;

      if (!productMap[prodId]) {
        productMap[prodId] = { id: prodId, title, qty: 0, sales: 0 };
      }
      productMap[prodId].qty += item.quantity;
      productMap[prodId].sales += totalCost;

      categoryMap[catName] = (categoryMap[catName] ?? 0) + totalCost;
    }

    const topProducts = Object.values(productMap)
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 10);

    const leastSellingProducts = Object.values(productMap)
      .sort((a, b) => a.sales - b.sales)
      .slice(0, 10);

    const revenueByCategory = Object.entries(categoryMap).map(([category, revenue]) => ({
      category,
      revenue
    }));

    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const thisMonthShipments = await this.orderShipmentModel.findAll({
      where: {
        shopId: id,
        status: { [Op.in]: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] as any },
        deliveredAt: { [Op.gte]: startOfThisMonth }
      },
      include: [{ model: OrderItem, as: "items" }]
    });

    const lastMonthShipments = await this.orderShipmentModel.findAll({
      where: {
        shopId: id,
        status: { [Op.in]: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] as any },
        deliveredAt: { [Op.gte]: startOfLastMonth, [Op.lte]: endOfLastMonth }
      },
      include: [{ model: OrderItem, as: "items" }]
    });

    let thisMonthRevenue = 0;
    for (const s of thisMonthShipments) {
      for (const item of s.items ?? []) {
        thisMonthRevenue += Number(item.unitPrice || item.price || 0) * item.quantity;
      }
    }

    let lastMonthRevenue = 0;
    for (const s of lastMonthShipments) {
      for (const item of s.items ?? []) {
        lastMonthRevenue += Number(item.unitPrice || item.price || 0) * item.quantity;
      }
    }

    const monthlyGrowth = lastMonthRevenue > 0
      ? ((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100
      : 0;

    const customerShipments = await this.orderShipmentModel.findAll({
      where: { shopId: id },
      include: [{ model: Order, as: "order", attributes: ["userId"] }]
    });

    const userOrderCounts: Record<string, number> = {};
    for (const s of customerShipments) {
      if (s.order?.userId) {
        userOrderCounts[s.order.userId] = (userOrderCounts[s.order.userId] ?? 0) + 1;
      }
    }

    const customerCount = Object.keys(userOrderCounts).length;
    const repeatCustomers = Object.values(userOrderCounts).filter(count => count > 1).length;

    return {
      topProducts,
      leastSellingProducts,
      revenueByCategory,
      monthlyGrowth,
      customerCount,
      repeatCustomers
    };
  }

  /**
   * Reject a payload that both picks an existing manager AND asks for a new one —
   * the intent is ambiguous and only one of them could win.
   */
  private assertSingleManagerIntent(b: ShopDto) {
    if (b.managerId && b.newManager) {
      throw new BadRequestException(
        "VALIDATION_FAILED",
        "Choose either an existing shop manager or create a new one — not both.",
      );
    }
  }

  /**
   * Provision the inline "Create New Shop Manager" account for `shopId`, INSIDE the
   * caller's transaction so the shop and its manager are committed together (or not
   * at all). The account is created with role=shop_manager and shopId already set,
   * which is what keeps it scopable — a manager row is never written without a shop.
   * Returns the new user's id for the shop's managerId.
   */
  private async provisionManager(nm: NewShopManagerDto, shopId: string, t: Transaction): Promise<string> {
    const email = nm.email.trim().toLowerCase();
    const clash = await this.userModel.findOne({ where: { email }, transaction: t });
    if (clash) {
      throw new BadRequestException("VALIDATION_FAILED", `A user with the email "${email}" already exists`);
    }
    const manager = await this.userModel.create({
      name: nm.name.trim(),
      email,
      phone: nm.phone?.trim() || null,
      passwordHash: await hashPassword(nm.password),
      role: Role.SHOP_MANAGER,
      shopId,
      isActive: true,
    } as any, { transaction: t });

    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.SHOP_MANAGER_CREATED,
      variables: { userId: manager.id, email: manager.email },
    });

    return manager.id;
  }

  @ApiBearerAuth()
  @RequirePermissions('shops.create')
  @Post()
  async create(@CurrentUser() u: JwtPayload, @Body() b: ShopDto) {
    this.assertSingleManagerIntent(b);

    const existing = await this.shop.findOne({ where: { name: { [Op.iLike]: b.name } } });
    if (existing) {
      throw new BadRequestException("VALIDATION_FAILED", `Shop with name "${b.name}" already exists`);
    }

    if (b.managerId) {
      await this.validateManager(b.managerId, null, u.sub);
    }

    // Shop + inline manager are one atomic unit: a failure provisioning the account
    // rolls the shop back, so we never leave a half-created shop with no manager
    // (or an orphaned manager pointing at a shop that was never committed).
    const created = await this.sequelize.transaction(async (t) => {
      const { newManager, ...shopFields } = b as any;
      const shop = await this.shop.create(shopFields, { transaction: t });

      if (newManager) {
        // The shop row exists inside this tx, so its id is available to the FK.
        const managerId = await this.provisionManager(newManager, shop.id, t);
        await shop.update({ managerId }, { transaction: t });
      } else if (shop.managerId) {
        await this.userModel.update({ shopId: shop.id }, { where: { id: shop.managerId }, transaction: t });
      }

      await this.auditLogModel.create({
        actorId: u.sub,
        action: "create_shop",
        entity: "Shop",
        entityId: shop.id,
        before: null,
        after: shop.toJSON(),
      } as any, { transaction: t });

      return shop;
    });

    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.SHOP_CREATED,
      variables: { shopId: created.id, shopName: created.name }
    });

    return created;
  }

  @ApiBearerAuth()
  @RequirePermissions('shops.edit')
  @Patch(":id")
  async patch(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: ShopDto) {
    this.assertSingleManagerIntent(b);

    const shop = await this.shop.findByPk(id);
    if (!shop) throw new NotFoundException("NOT_FOUND", "Shop not found");

    if (b.version !== undefined && shop.version !== b.version) {
      throw new ConflictException("CONFLICT", "Optimistic locking conflict: Shop was modified by another user");
    }

    if (b.name && b.name.toLowerCase() !== shop.name.toLowerCase()) {
      const existing = await this.shop.findOne({ where: { name: { [Op.iLike]: b.name }, id: { [Op.ne]: id } } });
      if (existing) {
        throw new BadRequestException("VALIDATION_FAILED", `Shop with name "${b.name}" already exists`);
      }
    }

    if (b.managerId && b.managerId !== shop.managerId) {
      await this.validateManager(b.managerId, id, u.sub);
    }

    const before = shop.toJSON();
    const updatePayload: any = { ...b };
    delete updatePayload.version;
    delete updatePayload.newManager;

    // Mirrors create(): the edit and its inline manager commit together.
    const after = await this.sequelize.transaction(async (t) => {
      if (b.newManager) {
        // Replacing the manager — release the outgoing one first.
        if (shop.managerId) {
          await this.userModel.update({ shopId: null }, { where: { id: shop.managerId }, transaction: t });
        }
        updatePayload.managerId = await this.provisionManager(b.newManager, id, t);
      }

      await this.shop.update(updatePayload, { where: { id }, transaction: t });
      const fresh = await this.shop.findByPk(id, { transaction: t });

      // Only a managerId that is actually sent changes the manager. Comparing against an
      // omitted one released the current manager on any edit (e.g. a radius change), which
      // cleared their shopId and locked them out of their own fulfilment queue.
      if (!b.newManager && b.managerId !== undefined) {
        if (shop.managerId && shop.managerId !== b.managerId) {
          await this.userModel.update({ shopId: null }, { where: { id: shop.managerId }, transaction: t });
        }
        if (b.managerId && b.managerId !== shop.managerId) {
          await this.userModel.update({ shopId: id }, { where: { id: b.managerId }, transaction: t });
        }
      }

      await this.auditLogModel.create({
        actorId: u.sub,
        action: "update_shop",
        entity: "Shop",
        entityId: id,
        before,
        after: fresh?.toJSON(),
      } as any, { transaction: t });

      return fresh;
    });

    return after;
  }

  @ApiBearerAuth()
  @RequirePermissions('shops.deactivate')
  @Post(":id/disable")
  async disable(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const shop = await this.shop.findByPk(id);
    if (!shop) throw new NotFoundException("NOT_FOUND", "Shop not found");

    const before = shop.toJSON();
    await shop.update({ isActive: false });
    const after = await this.shop.findByPk(id);

    await this.auditLogModel.create({
      actorId: u.sub,
      action: "disable_shop",
      entity: "Shop",
      entityId: id,
      before,
      after: after?.toJSON(),
    } as any);

    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.SHOP_DISABLED,
      variables: { shopId: id, shopName: shop.name }
    });

    return { disabled: true, warning: "New orders will stop routing to this shop. Existing active shipments must be processed and completed normally by this shop." };
  }

  @ApiBearerAuth()
  @RequirePermissions('shops.deactivate')
  @Post(":id/enable")
  async enable(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const shop = await this.shop.findByPk(id);
    if (!shop) throw new NotFoundException("NOT_FOUND", "Shop not found");

    const before = shop.toJSON();
    await shop.update({ isActive: true });
    const after = await this.shop.findByPk(id);

    await this.auditLogModel.create({
      actorId: u.sub,
      action: "enable_shop",
      entity: "Shop",
      entityId: id,
      before,
      after: after?.toJSON(),
    } as any);

    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.SHOP_ACTIVATED,
      variables: { shopId: id, shopName: shop.name }
    });

    return { enabled: true };
  }

  @ApiBearerAuth()
  @RequirePermissions('shops.deactivate')
  @Delete(":id")
  async delete(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const shop = await this.shop.findByPk(id);
    if (!shop) throw new NotFoundException("NOT_FOUND", "Shop not found");

    const activeShipment = await this.orderShipmentModel.findOne({
      where: {
        shopId: id,
        status: { [Op.notIn]: [OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.RETURNED, OrderStatus.REFUNDED, OrderStatus.FAILED] }
      }
    });
    if (activeShipment) {
      const reason = `Shop has active shipments: Shipment #${activeShipment.shipmentNumber}`;
      await this.auditLogModel.create({
        actorId: u.sub,
        action: "SHOP_DELETE_BLOCKED",
        entity: "Shop",
        entityId: id,
        before: null,
        after: { reason }
      } as any);
      throw new BadRequestException("VALIDATION_FAILED", reason);
    }

    const activeReturn = await this.returnModel.findOne({
      where: {
        status: { [Op.notIn]: ["refunded", "rejected"] }
      },
      include: [{
        model: OrderItem,
        as: "orderItem",
        where: { shopId: id },
        required: true
      }]
    });
    if (activeReturn) {
      const reason = `Shop has pending returns: Return ID ${activeReturn.id}`;
      await this.auditLogModel.create({
        actorId: u.sub,
        action: "SHOP_DELETE_BLOCKED",
        entity: "Shop",
        entityId: id,
        before: null,
        after: { reason }
      } as any);
      throw new BadRequestException("VALIDATION_FAILED", reason);
    }

    const activeRefund = await this.paymentRefundModel.findOne({
      where: {
        status: { [Op.in]: ["pending", "processing"] }
      },
      include: [{
        model: Payment,
        as: "payment",
        required: true,
        include: [{
          model: Order,
          as: "order",
          required: true,
          include: [{
            model: OrderShipment,
            as: "shipments",
            where: { shopId: id },
            required: true
          }]
        }]
      }]
    });
    if (activeRefund) {
      const reason = `Shop has pending refunds: Refund ID ${activeRefund.id}`;
      await this.auditLogModel.create({
        actorId: u.sub,
        action: "SHOP_DELETE_BLOCKED",
        entity: "Shop",
        entityId: id,
        before: null,
        after: { reason }
      } as any);
      throw new BadRequestException("VALIDATION_FAILED", reason);
    }

    const before = shop.toJSON();

    if (shop.managerId) {
      await this.userModel.update({ shopId: null }, { where: { id: shop.managerId } });
    }

    await shop.destroy();

    await this.auditLogModel.create({
      actorId: u.sub,
      action: "delete_shop",
      entity: "Shop",
      entityId: id,
      before,
      after: { deleted: true }
    } as any);

    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.SHOP_DELETED,
      variables: { shopId: id, shopName: shop.name }
    });

    return { deleted: true };
  }

  private async validateManager(managerId: string, shopId: string | null, actorId: string) {
    const manager = await this.userModel.findByPk(managerId);
    if (!manager) {
      await this.auditLogModel.create({
        actorId,
        action: "MANAGER_ASSIGNMENT_FAILED",
        entity: "Shop",
        entityId: shopId,
        before: null,
        after: { managerId, reason: "Manager account not found" }
      } as any);
      throw new BadRequestException("VALIDATION_FAILED", "Manager account not found");
    }

    if (manager.role !== Role.SHOP_MANAGER) {
      await this.auditLogModel.create({
        actorId,
        action: "MANAGER_ASSIGNMENT_FAILED",
        entity: "Shop",
        entityId: shopId,
        before: null,
        after: { managerId, reason: "User does not have shop_manager role" }
      } as any);
      throw new BadRequestException("VALIDATION_FAILED", "User does not have shop_manager role");
    }

    if (!manager.isActive) {
      await this.auditLogModel.create({
        actorId,
        action: "MANAGER_ASSIGNMENT_FAILED",
        entity: "Shop",
        entityId: shopId,
        before: null,
        after: { managerId, reason: "Manager account is inactive" }
      } as any);
      throw new BadRequestException("VALIDATION_FAILED", "Manager account is inactive");
    }

    const otherShop = await this.shop.findOne({
      where: {
        managerId,
        ...(shopId ? { id: { [Op.ne]: shopId } } : {})
      }
    });
    if (otherShop) {
      await this.auditLogModel.create({
        actorId,
        action: "MANAGER_ASSIGNMENT_FAILED",
        entity: "Shop",
        entityId: shopId,
        before: null,
        after: { managerId, reason: `Manager is already assigned to shop: ${otherShop.name}` }
      } as any);
      throw new BadRequestException("VALIDATION_FAILED", `Manager is already assigned to shop: ${otherShop.name}`);
    }
  }
}
