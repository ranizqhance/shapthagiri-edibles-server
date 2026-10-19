import { Body, Controller, Get, Module, Param, Post, Put, Delete, Query, UseGuards, forwardRef } from "@nestjs/common";
// App error classes — the global filter renders raw NestJS HttpExceptions as 500.
import { BadRequestException, NotFoundException } from "@/common/errors/http";
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { Campaign, Coupon, CouponRedemption, CouponHistory, GiftCard, GiftCardTransaction, LoyaltyAccount, LoyaltyTransaction, Referral, AuditLog, Cart, CartItem, Order, User, IdempotencyKey, Setting, Deal, Product, Promotion, PromotionRedemption } from "@/models";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { Public } from "@/common/decorators/public.decorator";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate } from "@/common/utils/crud.util";
import { CampaignDto, CartCouponApplyDto, EligibleCouponsDto, CouponDto, UpdateCouponDto, GiftCardDto, LoyaltyAdjustDto, DealDto, UpdateDealDto, PromotionDto, UpdatePromotionDto, ResolvePromotionsDto, OrchestratePreviewDto } from "@/common/dto/common.dto";
import { PromotionsService } from "./promotions.service";
import { LoyaltyService } from "./loyalty.service";
import { DealsService } from "./deals.service";
import { EligibilityService } from "./eligibility.service";
import { PromotionEngineService } from "./promotion-engine.service";
import { PricingOrchestrator } from "./pricing-orchestrator.service";
import { PromotionAnalyticsService } from "./promotion-analytics.service";
import { CouponSchedulerQueue } from "./promotions.queue";

@ApiTags("Promotions")
@ApiBearerAuth()
@Controller("promotions")
export class PromotionsController {
  constructor(
    private promotions: PromotionsService,
    private loyaltyService: LoyaltyService,
    private deals: DealsService,
    private promoEngine: PromotionEngineService,
    private orchestrator: PricingOrchestrator,
    private promoAnalytics: PromotionAnalyticsService,
    @InjectModel(Coupon) private coupon: typeof Coupon,
    @InjectModel(CouponRedemption) private cr: typeof CouponRedemption,
    @InjectModel(LoyaltyAccount) private la: typeof LoyaltyAccount,
    @InjectModel(LoyaltyTransaction) private lt: typeof LoyaltyTransaction,
    @InjectModel(Referral) private ref: typeof Referral,
    @InjectModel(GiftCard) private gc: typeof GiftCard,
    @InjectModel(Campaign) private camp: typeof Campaign,
    @InjectModel(CouponHistory) private history: typeof CouponHistory,
    @InjectModel(User) private user: typeof User,
  ) {}

  @RequirePermissions('coupons.view')
  @ApiOperation({ summary: "List all coupons" })
  @Get("coupons") 
  coupons(@Query() opts: PageOptionsDto) {
    return paginate(this.coupon, opts, {}, [{ model: CouponRedemption, as: "redemptions", where: { isActive: true }, required: false }]);
  }

  @RequirePermissions('coupons.create')
  @ApiOperation({ summary: "Create a new coupon" })
  @Post("coupons") 
  createCoupon(@CurrentUser() u: JwtPayload, @Body() b: CouponDto) { 
    return this.promotions.createCoupon(b, u.sub); 
  }

  @RequirePermissions('coupons.edit')
  @ApiOperation({ summary: "Update an existing coupon" })
  @Put("coupons/:id") 
  updateCoupon(@Param("id") id: string, @CurrentUser() u: JwtPayload, @Body() b: UpdateCouponDto) { 
    return this.promotions.updateCoupon(id, b, u.sub); 
  }

  @RequirePermissions('coupons.delete')
  @ApiOperation({ summary: "Delete a coupon" })
  @Delete("coupons/:id") 
  deleteCoupon(@Param("id") id: string, @CurrentUser() u: JwtPayload) { 
    return this.promotions.deleteCoupon(id, u.sub); 
  }

  @RequirePermissions('coupons.view')
  @ApiOperation({ summary: "Get comprehensive details of a coupon including analytics and version history" })
  @Get("coupons/:id/details")
  getCouponDetails(@Param("id") id: string) {
    return this.promotions.getCouponDetails(id);
  }

  @ApiOperation({ summary: "Apply coupon to cart" })
  @Post("coupons/apply") 
  async apply(@CurrentUser() u: JwtPayload, @Body() b: CartCouponApplyDto) {
    const { coupon, discount, freeDelivery, bogoRewards, bogoSavings } = await this.promotions.evaluateCoupon(
      b.code, b.cartTotal, u.sub, b.items, b.paymentMethod, b.deliveryMethod
    );
    return { coupon, discount, freeDelivery, bogoRewards: bogoRewards ?? [], bogoSavings: bogoSavings ?? 0 };
  }
  @ApiOperation({ summary: "Get auto best coupon for current cart" })
  @Get("coupons/auto-apply-best")
  async best(@CurrentUser() u: JwtPayload, @Query('cartTotal') cartTotal?: string) {
    // Query params arrive as strings; pass a real number when present, otherwise
    // let the service derive the subtotal from the caller's active cart.
    const subtotal = Number(cartTotal);
    return this.promotions.getAutoBestCoupon(Number.isFinite(subtotal) ? subtotal : undefined, u.sub);
  }

  @ApiOperation({ summary: "Get all eligible coupons for current cart" })
  @Post("coupons/eligible")
  async eligible(@CurrentUser() u: JwtPayload, @Body() b: EligibleCouponsDto) {
    return this.promotions.getEligibleCoupons(
      b.cartTotal, u.sub, b.items, b.paymentMethod, b.deliveryMethod
    );
  }

  @RequirePermissions('coupons.view')
  @Get("coupons/:id/history")
  async getCouponHistory(@Param("id") id: string) {
    return this.history.findAll({
      where: { couponId: id },
      order: [["createdAt", "DESC"]],
      include: ["coupon"],
    });
  }

  @RequirePermissions('coupons.view') @Get("stats") async stats() {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const activeCoupons = await this.coupon.count({ where: { isActive: true } });
    const loyaltyMembers = await this.la.count();
    const referralsThisMonth = await this.ref.count({ where: { createdAt: { [Op.gte]: startOfMonth } } });

    // Revenue calculations
    const allRedemptions = await this.cr.findAll({ where: { isActive: true } });
    const allOrderIds = allRedemptions.map(r => r.orderId);
    
    let totalCouponRevenue = 0;
    let couponRevenueThisMonth = 0;
    let couponDiscountThisMonth = 0;
    const revenueByDate: Record<string, number> = {};
    const usageByDate: Record<string, number> = {};

    if (allOrderIds.length > 0) {
       const allOrders = await (this.cr.sequelize?.models.Order as any).findAll({ where: { id: allOrderIds } });
       allOrders.forEach((o: any) => {
          const val = Number(o.total || 0);
          totalCouponRevenue += val;
          if (new Date(o.createdAt) >= startOfMonth) {
             couponRevenueThisMonth += val;
             couponDiscountThisMonth += Number(o.discount || 0);
          }
          const dateStr = o.createdAt.toISOString().split("T")[0];
          revenueByDate[dateStr] = (revenueByDate[dateStr] || 0) + val;
       });
    }

    allRedemptions.forEach(r => {
       const dateStr = (r.createdAt as Date).toISOString().split("T")[0];
       usageByDate[dateStr] = (usageByDate[dateStr] || 0) + 1;
    });

    // Generate last 30 days chart data
    const chartData: any[] = [];
    for (let i = 29; i >= 0; i--) {
       const d = new Date();
       d.setDate(d.getDate() - i);
       const dateStr = d.toISOString().split("T")[0];
       chartData.push({
          date: dateStr,
          revenue: revenueByDate[dateStr] || 0,
          usage: usageByDate[dateStr] || 0
       });
    }

    return { 
       activeCoupons, loyaltyMembers, referralsThisMonth,
       totalCouponRevenue, couponRevenueThisMonth, couponDiscountThisMonth,
       totalRedemptions: allRedemptions.length,
       chartData
    };
  }

  @RequirePermissions('marketing.view') @Get("marketing-stats") async marketingStats() {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const camps = await this.camp.findAll();
    let push = 0, email = 0, sms = 0, inApp = 0;
    for (const c of camps) {
      const metrics = (c.metrics as any) || {};
      const sent = Number(metrics.sent || 0);
      if (c.channel === "push") push += sent;
      else if (c.channel === "email") email += sent;
      else if (c.channel === "sms") sms += sent;
      else if (c.channel === "in-app" || c.channel === "in_app") inApp += sent;
    }

    const activeMembers = await this.la.count();
    const pointsIssued = await this.lt.sum("points", { where: { points: { [Op.gt]: 0 } } }) || 0;
    const pointsRedeemed = Math.abs(await this.lt.sum("points", { where: { points: { [Op.lt]: 0 } } }) || 0);
    const redemptionRate = pointsIssued > 0 ? Math.round((pointsRedeemed / pointsIssued) * 1000) / 10 : 0;

    const referralsMtd = await this.ref.count({ where: { createdAt: { [Op.gte]: startOfMonth } } });
    const conversions = await this.ref.count({ where: { status: { [Op.in]: ["converted", "rewarded"] } } });
    const conversionRate = referralsMtd > 0 ? Math.round((conversions / referralsMtd) * 1000) / 10 : 0;
    const rewardsPaid = await this.ref.sum("rewardAmount", { where: { status: "rewarded" } }) || 0;

    return {
      channels: { push, email, sms, inApp },
      loyalty: { activeMembers, pointsIssued, pointsRedeemed, redemptionRate },
      referrals: { referralsMtd, conversions, conversionRate, rewardsPaid }
    };
  }
  @Get("me/loyalty") async loyalty(@CurrentUser() u: JwtPayload) {
    const [acc] = await this.la.findOrCreate({ where: { userId: u.sub }, defaults: { userId: u.sub } as any });
    const [transactions, expiring, config] = await Promise.all([
      this.lt.findAll({ where: { accountId: acc.id }, order: [["createdAt", "DESC"]], limit: 20 }),
      this.loyaltyService.getExpiringPoints(u.sub),
      this.loyaltyService.getPublicConfig(),
    ]);
    return { account: acc, transactions, expiring, config };
  }
  // Redemption is applied at checkout (order create). This standalone deduction had
  // no discount attached, so it silently burned points — guard it to prevent loss.
  @Post("me/loyalty/redeem") redeem() {
    throw new BadRequestException("BAD_REQUEST", "Loyalty points are redeemed at checkout — apply them on your order.");
  }

  /* ── Admin loyalty management ── */
  @RequirePermissions('loyalty.view')
  @ApiOperation({ summary: "List loyalty member accounts (search by name/email, filter by tier)" })
  @Get("loyalty/members")
  async loyaltyMembers(@Query() opts: PageOptionsDto) {
    const where: any = {};
    if (opts.status) where.tier = opts.status;
    if (opts.q) {
      const users = await this.user.findAll({
        where: { [Op.or]: [{ name: { [Op.iLike]: `%${opts.q}%` } }, { email: { [Op.iLike]: `%${opts.q}%` } }] },
        attributes: ["id"],
      });
      where.userId = { [Op.in]: users.map((u) => u.id) };
    }
    const { rows, count } = await this.la.findAndCountAll({
      where,
      order: [[opts.sortBy || "lifetimePoints", opts.order]],
      limit: opts.limit,
      offset: opts.offset,
    });
    const users = await this.user.findAll({
      where: { id: { [Op.in]: rows.map((r) => r.userId) } },
      attributes: ["id", "name", "email"],
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    const items = rows.map((r) => ({ ...r.toJSON(), user: userMap.get(r.userId) ?? null }));
    return { items, meta: { totalItems: count, page: opts.page, limit: opts.limit, totalPages: Math.ceil(count / opts.limit) } };
  }

  @RequirePermissions('loyalty.view')
  @ApiOperation({ summary: "Loyalty member account + ledger" })
  @Get("loyalty/members/:userId")
  async loyaltyMember(@Param("userId") userId: string) {
    const account = await this.la.findOne({ where: { userId } });
    if (!account) throw new NotFoundException("NOT_FOUND", "Loyalty account not found");
    const [user, transactions] = await Promise.all([
      this.user.findByPk(userId, { attributes: ["id", "name", "email"] }),
      this.lt.findAll({ where: { accountId: account.id }, order: [["createdAt", "DESC"]], limit: 100 }),
    ]);
    return { account: { ...account.toJSON(), user }, transactions };
  }

  @RequirePermissions('loyalty.adjust')
  @ApiOperation({ summary: "Manually adjust a member's loyalty points (audited)" })
  @Post("loyalty/adjust")
  adjustLoyalty(@CurrentUser() u: JwtPayload, @Body() b: LoyaltyAdjustDto) {
    return this.loyaltyService.manualAdjustment(u.sub, b.userId, Number(b.points), b.reason);
  }
  @Post("me/referral") async referral(@CurrentUser() u: JwtPayload) {
    const code = `REF-${u.sub.slice(0,6).toUpperCase()}`;
    const [r] = await this.ref.findOrCreate({ where: { referrerId: u.sub, code }, defaults: { referrerId: u.sub, code } as any });
    return r;
  }

  @RequirePermissions('marketing.view') @Get("campaigns") camps(@Query() opts: PageOptionsDto) { return paginate(this.camp, opts); }
  @RequirePermissions('marketing.create') @Post("campaigns") createCamp(@Body() b: CampaignDto) { return this.camp.create(b as any); }
  @RequirePermissions('marketing.edit') @Post("campaigns/:id/launch") async launch(@Param("id") id: string) {
    await this.camp.update({ status: "live", scheduledAt: new Date() }, { where: { id } }); return { launched: true };
  }

  /* ── Deals of the Day (admin CRUD, managed from the Marketing module) ── */
  @RequirePermissions('marketing.view') @ApiOperation({ summary: "List Deals of the Day" })
  @Get("deals") listDeals(@Query() opts: PageOptionsDto) { return this.deals.list(opts); }

  @RequirePermissions('marketing.create') @ApiOperation({ summary: "Create a Deal of the Day" })
  @Post("deals") createDeal(@CurrentUser() u: JwtPayload, @Body() b: DealDto) { return this.deals.create(b, u.sub); }

  @RequirePermissions('marketing.edit') @ApiOperation({ summary: "Update a Deal of the Day" })
  @Put("deals/:id") updateDeal(@Param("id") id: string, @Body() b: UpdateDealDto) { return this.deals.update(id, b); }

  @RequirePermissions('marketing.delete') @ApiOperation({ summary: "Delete a Deal of the Day" })
  @Delete("deals/:id") deleteDeal(@Param("id") id: string) { return this.deals.remove(id); }

  /* ── Promotion Engine (automatic promotions — plan Phase 1, read/preview only) ──
     Gated behind the `promotion.engine.enabled` setting; nothing in checkout/order
     consumes this yet. CRUD is minimal here (full admin UI is Phase 5). */
  @RequirePermissions('marketing.view') @ApiOperation({ summary: "Promotion Engine on/off status" })
  @Get("engine/status") async engineStatus() { return { enabled: await this.promoEngine.isEnabled() }; }

  @RequirePermissions('marketing.edit') @ApiOperation({ summary: "Toggle the Promotion Engine on/off" })
  @Post("engine/toggle") engineToggle(@Body() b: { enabled: boolean }) { return this.promoEngine.setEnabled(!!b.enabled); }

  @RequirePermissions('marketing.view') @ApiOperation({ summary: "Promotion analytics summary dashboard" })
  @Get("analytics/summary") promotionSummary() { return this.promoAnalytics.summary(); }

  @RequirePermissions('marketing.view') @ApiOperation({ summary: "List automatic promotions" })
  @Get("promotions") listPromotions(@Query() q: { type?: string; status?: string }) { return this.promoEngine.list(q); }

  @RequirePermissions('marketing.view') @ApiOperation({ summary: "Per-promotion performance analytics" })
  @Get("promotions/:id/analytics") promotionDetail(@Param("id") id: string) { return this.promoAnalytics.promotionAnalytics(id); }

  @RequirePermissions('marketing.create') @ApiOperation({ summary: "Create an automatic promotion" })
  @Post("promotions") createPromotion(@CurrentUser() u: JwtPayload, @Body() b: PromotionDto) { return this.promoEngine.create(b, u.sub); }

  @RequirePermissions('marketing.edit') @ApiOperation({ summary: "Update an automatic promotion" })
  @Put("promotions/:id") updatePromotion(@Param("id") id: string, @CurrentUser() u: JwtPayload, @Body() b: UpdatePromotionDto) { return this.promoEngine.update(id, b, u.sub); }

  @RequirePermissions('marketing.delete') @ApiOperation({ summary: "Delete an automatic promotion" })
  @Delete("promotions/:id") deletePromotion(@Param("id") id: string) { return this.promoEngine.remove(id); }

  @ApiOperation({ summary: "Preview: resolve active automatic promotions against a cart (read-only)" })
  @Post("promotions/resolve") resolvePromotions(@CurrentUser() u: JwtPayload, @Body() b: ResolvePromotionsDto) {
    return this.promoEngine.resolve(b.items, { userId: u.sub, shopId: b.shopId });
  }

  @Public()
  @ApiOperation({ summary: "Storefront discovery: applicable promotion badges per variant (read-only)" })
  @Post("promotions/badges") promotionBadges(@Body() b: ResolvePromotionsDto) {
    return this.promoEngine.applicableBadges(b.items || []);
  }

  @Public()
  @ApiOperation({ summary: "Storefront discovery: does each product have any variant offer (read-only)" })
  @Post("promotions/product-offers") productOffers(@Body() b: { productIds?: string[]; shopId?: string }) {
    return this.promoEngine.productOffers(b.productIds || [], b.shopId);
  }

  @RequirePermissions('marketing.edit') @ApiOperation({ summary: "Phase 4: mirror legacy BOGO coupons into the Promotion Engine (dry-run unless apply=true)" })
  @Post("promotions/migrate-bogo") migrateBogo(@CurrentUser() u: JwtPayload, @Query("apply") apply?: string) {
    return this.promoEngine.migrateBogoCoupons(apply === "true", u.sub);
  }

  @ApiOperation({ summary: "Preview: merge promotions + coupon into a unified pricing breakdown (read-only, Phase 2)" })
  @Post("pricing/preview") pricingPreview(@CurrentUser() u: JwtPayload, @Body() b: OrchestratePreviewDto) {
    return this.orchestrator.orchestrate({
      items: b.items, userId: u.sub, shopId: b.shopId,
      couponCode: b.couponCode, paymentMethod: b.paymentMethod, deliveryMethod: b.deliveryMethod,
    });
  }
}

import { GiftCardController } from "./gift-card.controller";
import { GiftCardService } from "./gift-card.service";
import { LoyaltyExpiryCron } from "./loyalty-expiry.cron";
import { NotificationsModule } from "../notifications/notifications.module";
import { TrackingModule } from "../tracking/tracking.gateway";

@Module({
  imports: [
    SequelizeModule.forFeature([Coupon, CouponRedemption, CouponHistory, LoyaltyAccount, LoyaltyTransaction, Referral, GiftCard, GiftCardTransaction, Campaign, AuditLog, Cart, CartItem, Order, User, IdempotencyKey, Setting, Deal, Product, Promotion, PromotionRedemption]),
    forwardRef(() => NotificationsModule),
    TrackingModule
  ],
  controllers: [PromotionsController, GiftCardController],
  providers: [PromotionsService, CouponSchedulerQueue, GiftCardService, LoyaltyService, LoyaltyExpiryCron, DealsService, EligibilityService, PromotionEngineService, PricingOrchestrator, PromotionAnalyticsService],
  exports: [PromotionsService, GiftCardService, LoyaltyService, EligibilityService, PromotionEngineService, PricingOrchestrator, PromotionAnalyticsService],
})
export class PromotionsModule {}
