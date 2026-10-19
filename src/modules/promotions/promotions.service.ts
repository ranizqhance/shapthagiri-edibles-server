import { Injectable, Logger, OnModuleInit, OnModuleDestroy, NotFoundException, BadRequestException } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Transaction } from "sequelize";
import { Coupon, CouponRedemption, LoyaltyAccount, LoyaltyTransaction, AuditLog, Cart, CartItem, Order } from "@/models";
import { CouponExpiredException, CouponNotApplicableException, CouponUsageLimitException } from "@/common/errors/domain";
import { CouponDto, UpdateCouponDto } from "@/common/dto/common.dto";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { createKvClient, KvClient } from "@/common/services/kv";
import { Op } from "sequelize";
import { LoyaltyService } from "./loyalty.service";
import { EligibilityService } from "./eligibility.service";

/**
 * A single free/discounted "Get" line a BOGO coupon grants. Computed at evaluation
 * time and (a) shown as a distinct line on the storefront and (b) materialised as a
 * real free OrderItem + inventory deduction when the order is placed.
 */
export interface BogoReward {
  variantId: string;
  shopId: string;
  quantity: number;
  unitPriceBefore: number;   // catalogue price of the get variant at the shop
  unitPrice: number;         // price after the BOGO discount (0 when 100% off)
  discountPercent: number;
  parentVariantId: string;   // the purchased ("buy") variant that earned this reward
  productName?: string;
  productImage?: string;
}

export interface CouponEvaluation {
  coupon: Coupon;
  discount: number;
  freeDelivery: boolean;
  /** BOGO reward lines (empty for non-BOGO coupons). */
  bogoRewards?: BogoReward[];
  /** Display-only rupee value of the BOGO benefit (Σ freeQty × priceBefore × pct/100). */
  bogoSavings?: number;
}

@Injectable()
export class PromotionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("PromotionsService");
  private redis!: KvClient;

  constructor(
    @InjectModel(Coupon) private coupon: typeof Coupon,
    @InjectModel(CouponRedemption) private redemption: typeof CouponRedemption,
    @InjectModel(LoyaltyAccount) private loyalty: typeof LoyaltyAccount,
    @InjectModel(LoyaltyTransaction) private loyaltyTx: typeof LoyaltyTransaction,
    @InjectModel(AuditLog) private audit: typeof AuditLog,
    @InjectModel(Cart) private cart: typeof Cart,
    @InjectModel(CartItem) private cartItem: typeof CartItem,
    @InjectModel(Order) private order: typeof Order,
    private eventEmitter: EventEmitter2,
    private loyaltyService: LoyaltyService,
    private eligibility: EligibilityService,
  ) {}

  onModuleInit() {
    this.redis = createKvClient();
  }

  async onModuleDestroy() {
    if (this.redis) await this.redis.quit();
  }

  /* ───────────────────────── Coupon CRUD ───────────────────────── */

  /**
   * Map a coupon status to its `isActive` flag. `isActive` is the single source
   * of truth used by the evaluation engine (getActiveCoupons / getCouponByCode),
   * so every non-live status must flip it off. Returns `undefined` when status is
   * absent so partial updates that don't touch status leave `isActive` untouched.
   */
  private resolveIsActive(status?: string): boolean | undefined {
    if (status === "active") return true;
    if (status === "draft" || status === "expired" || status === "inactive" || status === "paused") return false;
    return undefined;
  }

  /** Expected, non-error coupon rejections during bulk evaluation (eligible/auto-best). */
  private isExpectedCouponRejection(e: unknown): boolean {
    return e instanceof CouponNotApplicableException
        || e instanceof CouponExpiredException
        || e instanceof CouponUsageLimitException;
  }

  /** Load the user's active cart items (used when no virtual items are supplied). */
  private async resolveCartItems(userId?: string): Promise<CartItem[]> {
    if (!userId) return [];
    const userCart = await this.cart.findOne({ where: { userId, status: "active" }, include: [{ model: CartItem }] });
    return userCart && userCart.items ? userCart.items : [];
  }

  async createCoupon(data: CouponDto, actorId: string) {
    // Normalize the code so lowercase can never be persisted via any client/API.
    if (data.code) (data as any).code = data.code.trim().toUpperCase();

    const active = this.resolveIsActive(data.status);
    if (active !== undefined) (data as any).isActive = active;

    // BOGO is no longer a coupon type (Promotion Engine plan, Phase 6) — it is created
    // via the Promotion Engine. Coupons are pct / flat / free_delivery only.
    const coupon = await this.coupon.create(data as any);
    await this.audit.create({
      actorId, action: "CREATE", entity: "Coupon", entityId: coupon.id,
      after: coupon.toJSON(),
    } as any);
    await this.invalidateCouponCache();
    
    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.COUPON_CREATED,
      variables: { couponId: coupon.id, code: coupon.code }
    });
    
    return coupon;
  }

  async updateCoupon(id: string, data: UpdateCouponDto, actorId: string) {
    // Keep code normalized on edits too.
    if (data.code) (data as any).code = data.code.trim().toUpperCase();

    const coupon = await this.coupon.findByPk(id);
    if (!coupon) throw new NotFoundException("Coupon not found");
    const before = coupon.toJSON();

    const active = this.resolveIsActive(data.status);
    if (active !== undefined) (data as any).isActive = active;

    await coupon.update(data as any);
    
    // Check if there are actual changes (excluding updatedAt etc)
    const after = coupon.toJSON();
    const hasChanges = Object.keys(data).some(key => {
      // Basic comparison for top-level fields
      return JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(after[key as keyof typeof after]);
    });

    if (hasChanges) {
      // Assuming CouponHistory is injected in the module but we don't have it in constructor here yet.
      // Wait, let's inject it into the service.
      await (this.coupon.sequelize?.models.CouponHistory as any).create({
        couponId: coupon.id,
        actorId,
        beforeValues: before,
        afterValues: after,
      });
    }

    await this.audit.create({
      actorId, action: "UPDATE", entity: "Coupon", entityId: coupon.id,
      before, after,
    } as any);
    await this.invalidateCouponCache(coupon.code);
    
    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.COUPON_UPDATED,
      variables: { couponId: coupon.id, code: coupon.code }
    });
    
    return coupon;
  }

  async deleteCoupon(id: string, actorId: string) {
    const coupon = await this.coupon.findByPk(id);
    if (!coupon) throw new NotFoundException("Coupon not found");

    // Enterprise Best Practice: Do not allow deletion of coupons that have been redeemed.
    // They must be marked as inactive instead to preserve order history and analytics.
    const redemptionsCount = await this.redemption.count({ where: { couponId: id } });
    if (redemptionsCount > 0) {
       throw new BadRequestException(
          "BAD_REQUEST", 
          "This coupon has already been redeemed and cannot be deleted to preserve historical order records. Please mark it as 'Inactive' instead."
       );
    }

    const before = coupon.toJSON();
    
    // Rename code to free it up for future use (Soft Delete + Unique Constraint workaround).
    // Ensure the new code does not exceed the 40 character DB limit.
    const suffix = `_DEL_${Date.now()}`;
    const truncatedCode = coupon.code.substring(0, 40 - suffix.length);
    await coupon.update({ code: `${truncatedCode}${suffix}` } as any);
    
    await coupon.destroy();
    await this.audit.create({
      actorId, action: "DELETE", entity: "Coupon", entityId: coupon.id,
      before,
    } as any);
    await this.invalidateCouponCache(coupon.code);
    
    // Using COUPON_UPDATED for delete as there's no COUPON_DELETED in enum yet
    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.COUPON_UPDATED,
      variables: { couponId: coupon.id, code: coupon.code, deleted: true }
    });
    
    return { deleted: true };
  }

  async getCouponDetails(id: string) {
    const coupon = await this.coupon.findByPk(id);
    if (!coupon) throw new NotFoundException("Coupon not found");

    // Get Redemptions
    const redemptions = await this.redemption.findAll({ where: { couponId: id, isActive: true } });
    const orderIds = redemptions.map(r => r.orderId);

    let revenueGenerated = 0;
    let totalDiscountGiven = 0;
    let recentOrders: any[] = [];

    if (orderIds.length > 0) {
       const orders = await this.order.findAll({
         where: { id: orderIds },
         order: [["createdAt", "DESC"]],
         include: [{ association: "user", attributes: ["id", "name", "email"] }]
       });

       revenueGenerated = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
       totalDiscountGiven = orders.reduce((sum, o) => sum + Number(o.discount || 0), 0);
       recentOrders = orders.slice(0, 10);
    }

    // Get Version History
    const historyLogs = await (this.coupon.sequelize?.models.CouponHistory as any).findAll({
       where: { couponId: id },
       order: [["createdAt", "DESC"]],
       include: [{ association: "actor", attributes: ["id", "name", "email"] }]
    });

    return {
       coupon,
       analytics: {
          usageCount: redemptions.length,
          revenueGenerated,
          totalDiscountGiven,
          remainingUsageLimit: coupon.usageLimit ? Math.max(0, coupon.usageLimit - redemptions.length) : null,
       },
       recentOrders,
       versionHistory: historyLogs.map((log: any) => ({
         id: log.id,
         action: "UPDATE",
         actor: log.actor,
         createdAt: log.createdAt,
         before: log.beforeValues,
         after: log.afterValues
       }))
    };
  }

  private async invalidateCouponCache(code?: string) {
    await this.redis.del("coupons:active");
    if (code) {
      await this.redis.del(`coupon:${code}`);
    }
  }

  async getActiveCoupons() {
    const cached = await this.redis.get("coupons:active");
    if (cached) return JSON.parse(cached) as Coupon[];
    
    const coupons = await this.coupon.findAll({
      where: { isActive: true },
      order: [["priority", "DESC"]]
    });
    await this.redis.set("coupons:active", JSON.stringify(coupons), "EX", 300); // 5 min cache
    return coupons;
  }

  async getCouponByCode(code: string) {
    // Normalize so lookups, cache keys, and redemption are case-insensitive.
    code = code?.trim().toUpperCase();
    const cached = await this.redis.get(`coupon:${code}`);
    if (cached) return JSON.parse(cached) as Coupon;
    
    const coupon = await this.coupon.findOne({ where: { code, isActive: true } });
    if (coupon) {
      await this.redis.set(`coupon:${code}`, JSON.stringify(coupon), "EX", 300);
    }
    return coupon;
  }

  /* ───────────────────────── Engine ───────────────────────── */

  async evaluateCoupon(code: string, subtotal: number, userId?: string, virtualItems?: any[], paymentMethod?: string, deliveryMethod?: string): Promise<CouponEvaluation> {
    const couponData = await this.getCouponByCode(code);
    if (!couponData) throw new CouponNotApplicableException();

    // Work around for JSON parsing via redis
    const coupon = couponData as unknown as Coupon;
    
    const now = new Date();
    if (coupon.startsAt && new Date(coupon.startsAt) > now) throw new CouponNotApplicableException();
    if (coupon.expiresAt && new Date(coupon.expiresAt) < now) throw new CouponExpiredException();
    if (subtotal < Number(coupon.minOrder || 0)) throw new CouponNotApplicableException();

    if (coupon.usageLimit != null) {
      const used = await this.redemption.count({ where: { couponId: coupon.id, isActive: true } });
      if (used >= coupon.usageLimit) throw new CouponUsageLimitException();
    }

    if (coupon.perUserLimit != null && userId) {
      const usedByUser = await this.redemption.count({ where: { couponId: coupon.id, userId, isActive: true } });
      if (usedByUser >= coupon.perUserLimit) throw new CouponUsageLimitException();
    }

    let userOrdersCount = 0;
    if (userId) {
       userOrdersCount = await this.order.count({ where: { userId, status: { [Op.not]: "cancelled" } } });
    }

    if (coupon.firstOrderOnly && userId) {
       if (userOrdersCount > 0) throw new CouponNotApplicableException();
    }

    if (coupon.newCustomerOnly && userId && userOrdersCount > 0) throw new CouponNotApplicableException();

    // Rules Evaluation
    const cartItems: CartItem[] = virtualItems && virtualItems.length > 0
      ? virtualItems
      : await this.resolveCartItems(userId);
    
    // Scope + customer-segment gating (payment/delivery/product/category/brand/shop/
    // segment). Extracted into the shared EligibilityService (Promotion Engine Phase 0)
    // so the future Promotion Engine reuses the exact same predicates. Behaviour is
    // unchanged: throws CouponNotApplicableException on any failed rule.
    if (coupon.rules) {
      await this.eligibility.assertRulesMatch(coupon.rules as Record<string, any>, {
        cartItems,
        userId,
        paymentMethod,
        deliveryMethod,
        userOrdersCount,
      });
    }

    let discount = 0;
    let freeDelivery = false;
    let bogoRewards: BogoReward[] = [];
    let bogoSavings = 0;
    switch (coupon.type) {
      case "pct":
        discount = Math.round((subtotal * Number(coupon.value)) / 100);
        break;
      case "flat":
        discount = Math.min(Number(coupon.value), subtotal);
        break;
      case "free_delivery":
        freeDelivery = true;
        break;
      // NOTE: "bogo" is retired from the Coupon Engine (Promotion Engine plan, Phase 6).
      // Buy-X-Get-Y now lives entirely in the Promotion Engine (type buy_x_get_y /
      // buy_x_get_x). Legacy `bogo` coupons were migrated to promotions and deactivated;
      // any historical order keeps its frozen bogoSnapshot. If a legacy `bogo` coupon is
      // ever encountered here it simply yields no discount and no reward (falls through).
    }

    const realCoupon = await this.coupon.findByPk(coupon.id);
    return { coupon: realCoupon || coupon, discount, freeDelivery, bogoRewards, bogoSavings };
  }

  async getEligibleCoupons(subtotal: number, userId?: string, virtualItems?: any[], paymentMethod?: string, deliveryMethod?: string): Promise<CouponEvaluation[]> {
      const activeCoupons = await this.getActiveCoupons();
      const eligibleCoupons: CouponEvaluation[] = [];

      for (const c of activeCoupons) {
          try {
             const evalResult = await this.evaluateCoupon(c.code, subtotal, userId, virtualItems, paymentMethod, deliveryMethod);
             eligibleCoupons.push(evalResult);
          } catch (e) {
             // Expected domain rejections (not applicable / expired / usage limit) are
             // silently skipped; anything else is a real bug worth surfacing.
             if (!this.isExpectedCouponRejection(e)) {
                this.logger.warn(`Eligible evaluation failed for coupon ${c.code}: ${(e as Error)?.message ?? e}`);
             }
          }
      }

      // Sort by highest effective benefit. BOGO carries its value as `bogoSavings`
      // (its monetary `discount` is 0), so rank on the sum, else BOGO always sinks.
      return eligibleCoupons.sort(
        (a, b) => (b.discount + (b.bogoSavings || 0)) - (a.discount + (a.bogoSavings || 0)),
      );
  }

  async getAutoBestCoupon(subtotal?: number, userId?: string): Promise<CouponEvaluation | null> {
      // Coerce the incoming subtotal (query params arrive as strings). When it is
      // missing or non-positive, derive it from the caller's active cart so discount
      // math is never NaN and min-order rules stay meaningful.
      let sub = Number(subtotal);
      if (!Number.isFinite(sub) || sub <= 0) {
         const items = await this.resolveCartItems(userId);
         sub = items.reduce((s, i) => s + Number((i as any).priceSnapshot || 0) * Number(i.quantity || 0), 0);
      }

      const activeCoupons = await this.getActiveCoupons();
      let bestEvaluation: CouponEvaluation | null = null;

      for (const c of activeCoupons) {
          try {
             const evalResult = await this.evaluateCoupon(c.code, sub, userId);
             // Never let a non-finite discount win the comparison.
             if (!Number.isFinite(evalResult.discount)) continue;
             if (!bestEvaluation || evalResult.discount > bestEvaluation.discount) {
                 bestEvaluation = evalResult;
             }
          } catch (e) {
             if (!this.isExpectedCouponRejection(e)) {
                this.logger.warn(`Auto-best evaluation failed for coupon ${c.code}: ${(e as Error)?.message ?? e}`);
             }
          }
      }

      return bestEvaluation;
  }

  /** Persist a coupon redemption (called once an order using the coupon is placed). */
  async recordRedemption(code: string, userId: string, orderId: string, t?: Transaction) {
    code = code?.trim().toUpperCase();
    // Lock the coupon row to prevent race conditions during redemption
    const coupon = await this.coupon.findOne({ where: { code }, lock: t?.LOCK.UPDATE, transaction: t });
    if (!coupon) return;
    
    // Double check limits strictly within the locked transaction
    if (coupon.usageLimit != null) {
      const used = await this.redemption.count({ where: { couponId: coupon.id, isActive: true }, transaction: t });
      if (used >= coupon.usageLimit) throw new CouponUsageLimitException();
      if (used + 1 === coupon.usageLimit) {
        this.eventEmitter.emit("admin.notify", {
          eventType: NotificationEventType.COUPON_USAGE_LIMIT,
          variables: { couponId: coupon.id, code: coupon.code }
        });
      }
    }
    if (coupon.perUserLimit != null) {
      const usedByUser = await this.redemption.count({ where: { couponId: coupon.id, userId, isActive: true }, transaction: t });
      if (usedByUser >= coupon.perUserLimit) throw new CouponUsageLimitException();
    }

    await this.redemption.create({ couponId: coupon.id, userId, orderId, status: "reserved", isActive: true } as any, { transaction: t });
  }

  async finalizeRedemption(orderId: string, t?: Transaction) {
    await this.redemption.update(
      { status: "active" } as any,
      { where: { orderId, status: "reserved" }, transaction: t }
    );
  }

  async rollbackRedemption(orderId: string, t?: Transaction) {
    await this.redemption.update(
      { status: "cancelled", isActive: false } as any,
      { where: { orderId }, transaction: t }
    );
  }

  /* ───────────────────────── Loyalty ───────────────────────── */

  /**
   * Deduct loyalty points (standalone redeem endpoint). Delegates to the single
   * LoyaltyService engine so redeeming never demotes the customer's tier
   * (tiers are lifetime-based). Runs in its own row-locked transaction.
   */
  async burn(userId: string, points: number, orderId?: string) {
    if (points <= 0) throw new CouponNotApplicableException();
    return this.loyalty.sequelize!.transaction(async (t) => {
      await this.loyaltyService.redeemPoints(userId, points, orderId ?? (null as any), t);
      return this.loyalty.findOne({ where: { userId }, transaction: t });
    });
  }
}
