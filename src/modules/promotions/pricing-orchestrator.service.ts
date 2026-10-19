import { Injectable, Logger } from "@nestjs/common";
import { PromotionEngineService, PromotionResolution, PromotionRewardLine } from "./promotion-engine.service";
import { PromotionsService } from "./promotions.service";

export interface OrchestrateInput {
  items: any[];                 // cart lines: { variantId, quantity, shopId?, priceSnapshot? }
  userId?: string;
  shopId?: string;
  couponCode?: string;
  paymentMethod?: string;
  deliveryMethod?: string;
  /** Present at order placement — enables race-safe promotion-limit enforcement. */
  transaction?: import("sequelize").Transaction;
}

export interface OrchestrateResult {
  /** Whether the Promotion Engine flag is on. When false this is a pure coupon result. */
  engineEnabled: boolean;
  subtotal: number;             // Σ line prices before anything
  goodsSubtotal: number;        // subtotal + reward line value (rewards are goods; 0 for 100% off)
  promotionLineDiscount: number;// line + cart promotion discounts kept after stacking
  couponDiscount: number;       // coupon discount kept after stacking
  totalDiscount: number;        // promotionLineDiscount + couponDiscount → feeds PricingService.compute
  freeDelivery: boolean;
  rewardLines: PromotionRewardLine[];
  appliedPromotions: PromotionResolution["appliedPromotions"];
  coupon: any | null;
  couponError?: string;
  stacking: { stacked: boolean; reason: string };
  /** Promotions skipped because a usage/stock limit was reached (clear messaging). */
  limited: { id: string; name: string; reason: string }[];
}

/**
 * PricingOrchestrator (plan Phase 2). Merges the automatic Promotion Engine output with
 * the code-driven Coupon Engine into a single discount + reward-line result, applying the
 * approved priority/stacking rules (§3.1 / §3.2), ready to feed `PricingService.compute`.
 *
 * IMPORTANT (feature-flag contract):
 *  - When the Promotion Engine flag is OFF, this returns a PURE coupon-only result —
 *    identical to what the current checkout/order path computes today. This is what makes
 *    wiring it into the order flow (Phase 3) safe: flag-off ⇒ no behaviour change.
 *  - This service is READ-ONLY in Phase 2 (exposed via a preview endpoint). It does NOT
 *    modify the cart, coupons, or orders.
 */
@Injectable()
export class PricingOrchestrator {
  private readonly logger = new Logger(PricingOrchestrator.name);
  constructor(
    private readonly promoEngine: PromotionEngineService,
    private readonly coupons: PromotionsService,
  ) {}

  async orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
    const items = input.items || [];
    const subtotal = items.reduce(
      (s, i) => s + Number(i.priceSnapshot ?? i.price ?? 0) * Number(i.quantity ?? 0), 0,
    );

    // 1) Automatic promotions (empty & inert when the flag is off). The transaction, when
    //    present (order placement), makes promotion-limit enforcement race-safe.
    const promo = await this.promoEngine.resolve(items, { userId: input.userId, shopId: input.shopId, transaction: input.transaction });
    const promoLineDiscount = promo.totalLineDiscount + promo.cartDiscount;
    const promoRewardValue = promo.rewardLines.reduce((s, r) => s + r.unitPrice * r.quantity, 0);
    const promoRewardSavings = promo.rewardLines.reduce((s, r) => s + (r.unitPriceBefore - r.unitPrice) * r.quantity, 0);
    const promoBenefit = promoLineDiscount + promoRewardSavings;

    // 2) Coupon evaluated on the promotion-adjusted subtotal (coupon applies AFTER promos).
    const adjustedSubtotal = Math.max(0, subtotal - promoLineDiscount) + promoRewardValue;
    let coupon: any = null;
    let couponDiscount = 0;
    let freeDelivery = false;
    let couponRewards: PromotionRewardLine[] = [];
    let couponStackable = false;
    let couponError: string | undefined;

    if (input.couponCode) {
      try {
        const ev = await this.coupons.evaluateCoupon(
          input.couponCode, adjustedSubtotal, input.userId, items, input.paymentMethod, input.deliveryMethod,
        );
        coupon = ev.coupon;
        couponDiscount = ev.discount || 0;
        freeDelivery = ev.freeDelivery || false;
        couponRewards = (ev.bogoRewards || []) as any;
        couponStackable = !!(ev.coupon as any)?.stackable;
      } catch (e: any) {
        // Invalid/expired/not-applicable coupon: surface the reason, keep promotions.
        couponError = e?.response?.message ?? e?.message ?? "Coupon not applicable";
      }
    }
    const couponBenefit = couponDiscount; // free-delivery valued separately below

    // 3) Stacking decision (§3.2 coupon row): a promotion and a coupon stack only when
    //    BOTH sides are marked stackable; otherwise best-value wins.
    const promosApplied = promo.appliedPromotions.length > 0;
    const couponApplied = couponDiscount > 0 || freeDelivery || couponRewards.length > 0;
    let dropPromotions = false;
    let dropCoupon = false;
    let stacked = false;
    let reason = "single benefit";

    if (promosApplied && couponApplied) {
      const allPromoStackable = promo.appliedPromotions.every((a) => a.stackable);
      if (couponStackable && allPromoStackable) {
        stacked = true;
        reason = "both stackable → stacked";
      } else if (promoBenefit >= couponBenefit && !freeDelivery) {
        // Free-delivery coupons offer non-monetary value; don't let a promo silently beat one.
        dropCoupon = true;
        reason = "not stackable → promotion wins (higher value)";
      } else {
        dropPromotions = true;
        reason = "not stackable → coupon wins";
      }
    } else if (promosApplied) {
      reason = "promotions only";
    } else if (couponApplied) {
      reason = "coupon only";
    }

    // 4) Assemble the kept components.
    const keptPromoLineDiscount = dropPromotions ? 0 : promoLineDiscount;
    const keptPromoRewards = dropPromotions ? [] : promo.rewardLines;
    const keptCouponDiscount = dropCoupon ? 0 : couponDiscount;
    const keptFreeDelivery = dropCoupon ? false : freeDelivery;
    const keptCouponRewards = dropCoupon ? [] : couponRewards;

    // Merge promotion rewards + legacy coupon BOGO rewards, de-duplicated by
    // (parent → get variant → shop). During the Phase 4 migration a legacy `bogo`
    // coupon and its mirrored promotion could both be live; without this the same free
    // item would be granted twice. Promotion rewards are listed first, so they win.
    const rewardLines: PromotionRewardLine[] = [];
    const seenReward = new Set<string>();
    for (const r of [...keptPromoRewards, ...keptCouponRewards]) {
      const key = `${r.parentVariantId}|${r.variantId}|${r.shopId}`;
      if (seenReward.has(key)) continue;
      seenReward.add(key);
      rewardLines.push(r);
    }
    const rewardValue = rewardLines.reduce((s, r) => s + r.unitPrice * r.quantity, 0);
    const goodsSubtotal = subtotal + rewardValue;
    const totalDiscount = keptPromoLineDiscount + keptCouponDiscount;

    return {
      engineEnabled: promo.enabled,
      subtotal,
      goodsSubtotal,
      promotionLineDiscount: keptPromoLineDiscount,
      couponDiscount: keptCouponDiscount,
      totalDiscount,
      freeDelivery: keptFreeDelivery,
      rewardLines,
      appliedPromotions: dropPromotions ? [] : promo.appliedPromotions,
      coupon: dropCoupon ? null : coupon,
      couponError,
      stacking: { stacked, reason },
      limited: promo.limited || [],
    };
  }
}
