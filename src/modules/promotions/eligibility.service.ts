import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { LoyaltyAccount, ProductVariant } from "@/models";
import { CouponNotApplicableException } from "@/common/errors/domain";

/** Context a scope/segment evaluation needs. All fields are supplied by the caller
 *  (coupon engine today, promotion engine in a later phase). */
export interface EligibilityContext {
  /** Cart lines being evaluated (each has `variantId`, `quantity`, optional `shopId`). */
  cartItems: any[];
  userId?: string;
  paymentMethod?: string;
  deliveryMethod?: string;
  /** Non-cancelled order count for the user — drives new/returning segment checks. */
  userOrdersCount: number;
}

/**
 * Shared eligibility predicates (scope + customer segments) extracted VERBATIM from
 * `PromotionsService.evaluateCoupon` (Phase 0 of the Promotion Engine plan). Behaviour
 * is intentionally identical — this is a pure refactor so both the Coupon Engine and the
 * future Promotion Engine share one predicate implementation. Throws
 * `CouponNotApplicableException` when any rule fails; returns void when all pass (or when
 * there are no rules).
 */
@Injectable()
export class EligibilityService {
  constructor(
    @InjectModel(LoyaltyAccount) private loyalty: typeof LoyaltyAccount,
  ) {}

  /**
   * Evaluate a coupon/promotion `rules` object against the cart. Mirrors the original
   * inline block: payment methods, delivery methods, excluded products, product/variant
   * inclusion, category, brand, shop, and customer segments.
   */
  async assertRulesMatch(rules: Record<string, any> | null | undefined, ctx: EligibilityContext): Promise<void> {
    if (!rules) return;

    const cartItems = ctx.cartItems || [];
    const { userId, paymentMethod, deliveryMethod, userOrdersCount } = ctx;

    const variantIds = cartItems.map((i) => i.variantId);
    const variants = await ProductVariant.findAll({
      where: { id: variantIds },
      include: [
        { association: "product" },
        { association: "inventory" },
      ],
    });

    // 1. Payment Methods
    if (rules.paymentMethods && rules.paymentMethods.length > 0 && paymentMethod) {
      if (!rules.paymentMethods.includes(paymentMethod)) {
        throw new CouponNotApplicableException();
      }
    }

    // 2. Delivery Methods
    if (rules.deliveryMethods && rules.deliveryMethods.length > 0 && deliveryMethod) {
      if (!rules.deliveryMethods.includes(deliveryMethod)) {
        throw new CouponNotApplicableException();
      }
    }

    // 3. Excluded Products
    if (rules.excludedProductVariantIds && rules.excludedProductVariantIds.length > 0) {
      const hasExcluded = variants.some((v) => rules.excludedProductVariantIds.includes(v.id) || rules.excludedProductVariantIds.includes(v.productId));
      if (hasExcluded) throw new CouponNotApplicableException();
    }

    // For inclusion rules, at least one item in the cart must match the condition (standard commerce behavior for cart-level discount)

    // 4. Product/Variant Inclusion
    if (rules.productVariantIds && rules.productVariantIds.length > 0) {
      const hasEligible = variants.some((v) => rules.productVariantIds.includes(v.id) || rules.productVariantIds.includes(v.productId) || rules.productVariantIds.includes(v.sku));
      if (!hasEligible) throw new CouponNotApplicableException();
    } else if (rules.productIds && rules.productIds.length > 0) {
      // Backward compatibility
      const hasEligible = variants.some((v) => rules.productIds.includes(v.id) || rules.productIds.includes(v.productId) || rules.productIds.includes(v.sku));
      if (!hasEligible) throw new CouponNotApplicableException();
    }

    // 5. Category Inclusion
    if (rules.categoryIds && rules.categoryIds.length > 0) {
      const hasEligible = variants.some((v) => v.product && rules.categoryIds.includes(v.product.categoryId));
      if (!hasEligible) throw new CouponNotApplicableException();
    }

    // 6. Brand Inclusion
    if (rules.brandIds && rules.brandIds.length > 0) {
      const hasEligible = variants.some((v) => v.product && rules.brandIds.includes(v.product.brandId));
      if (!hasEligible) throw new CouponNotApplicableException();
    }

    // 7. Shop Inclusion
    if (rules.shopIds && rules.shopIds.length > 0) {
      const hasEligible = variants.some((v) => {
        if (!v.inventory) return false;
        return v.inventory.some((inv: any) => rules.shopIds.includes(inv.shopId));
      });
      if (!hasEligible) throw new CouponNotApplicableException();
    }

    // 8. Customer Segments
    if (rules.customerSegments && rules.customerSegments.length > 0 && userId) {
      const isNewCustomer = userOrdersCount === 0;
      const isReturning = userOrdersCount > 0;
      let segmentMatched = false;

      if (rules.customerSegments.includes("New Customers") && isNewCustomer) segmentMatched = true;
      if (rules.customerSegments.includes("Returning") && isReturning) segmentMatched = true;

      if (rules.customerSegments.includes("Loyalty Members") || rules.customerSegments.includes("VIP")) {
        const la = await this.loyalty.findOne({ where: { userId } });
        if (la) {
          if (rules.customerSegments.includes("Loyalty Members")) segmentMatched = true;
          if (rules.customerSegments.includes("VIP") && (la.tier === "gold" || la.tier === "platinum")) segmentMatched = true;
        }
      }
      if (rules.customerSegments.includes("Referral Users")) {
        const ref = await this.loyalty.sequelize?.model("Referral").findOne({ where: { refereeId: userId } });
        if (ref) segmentMatched = true;
      }

      if (!segmentMatched) throw new CouponNotApplicableException();
    }
  }
}
