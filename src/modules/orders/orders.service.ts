import { Injectable, BadRequestException, Inject, forwardRef, Logger } from "@nestjs/common";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { Op } from "sequelize";
import { Cart, CartItem, IdempotencyKey, Invoice, Order, OrderItem, OrderShipment, OrderStatusHistory, ProductVariant, RoutingDecision, ShopInventory, StockMovement, AuditLog, CouponRedemption, DeliveryAssignment, Payment, PaymentRefund, DeliveryPartner, Product, ProductMedia, User, GiftCard, PromotionRedemption, Setting } from "@/models";
import { OrderStatus, PaymentMethod, PaymentStatus } from "@/common/enums/order-status.enum";
import { CartEmptyException, CancellationWindowExpiredException, OrderAlreadyCancelledException, OutOfStockException } from "@/common/errors/domain";
import { NotFoundException, ConflictException, ForbiddenException, BadRequestException as AppBadRequestException } from "@/common/errors/http";
import { DeliveryEngineService } from "@/modules/delivery-engine/delivery-engine.service";
import { PromotionsService } from "@/modules/promotions/promotions.service";
import { PromotionEngineService } from "@/modules/promotions/promotion-engine.service";
import { PricingOrchestrator } from "@/modules/promotions/pricing-orchestrator.service";
import { PricingService } from "@/modules/orders/pricing.service";
import { NotificationsService } from "@/modules/notifications/notifications.service";
import { GiftCardService } from "@/modules/promotions/gift-card.service";
import { WalletService } from "@/modules/wallet/wallet.service";
import { withIdempotency } from "@/common/utils/idempotency.util";
import { readOrderLookupToken, orderTrackingUrl } from "@/common/utils/order-lookup.util";
import { isDeliverableEmail } from "@/common/utils/email.util";
import { computeLineAllocations } from "@/common/utils/order-allocation.util";
import { computeParcelWeight } from "@/common/utils/order-weight.util";
import { storageProvider } from "@/common/providers/storage.provider";
import { paymentProvider } from "@/common/providers/payment.provider";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { LoyaltyService } from "@/modules/promotions/loyalty.service";
import { Transaction } from "sequelize";
import { Role } from "@/common/enums/role.enum";
import { NotificationQueueService } from "../notifications/notification.queue";
import { NotificationEventType } from "@/common/enums/notification-event.enum";

import { EventEmitter2 } from "@nestjs/event-emitter";
import { env } from "@/config/env";
import { Cron, CronExpression } from "@nestjs/schedule";
import { htmlToPdf } from "@/common/utils/pdf.util";
import { BRAND } from "@/common/brand";

/** Shipment states in which the customer already has the goods. */
const DELIVERED_STATES: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.RETURN_REQUESTED, OrderStatus.RETURN_APPROVED, OrderStatus.RETURNED, OrderStatus.REFUND_PENDING, OrderStatus.REFUNDED];

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(
    @InjectConnection() private sequelize: Sequelize,
    @InjectModel(Cart) private cart: typeof Cart,
    @InjectModel(CartItem) private cartItem: typeof CartItem,
    @InjectModel(Order) private order: typeof Order,
    @InjectModel(OrderShipment) private shipment: typeof OrderShipment,
    @InjectModel(OrderItem) private orderItem: typeof OrderItem,
    @InjectModel(OrderStatusHistory) private history: typeof OrderStatusHistory,
    @InjectModel(RoutingDecision) private routing: typeof RoutingDecision,
    @InjectModel(ShopInventory) private inv: typeof ShopInventory,
    @InjectModel(StockMovement) private mov: typeof StockMovement,
    @InjectModel(ProductVariant) private variant: typeof ProductVariant,
    @InjectModel(IdempotencyKey) private idem: typeof IdempotencyKey,
    @InjectModel(Invoice) private invoiceModel: typeof Invoice,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    @InjectModel(CouponRedemption) private couponRedemptionModel: typeof CouponRedemption,
    @InjectModel(PromotionRedemption) private promoRedemptionModel: typeof PromotionRedemption,
    @InjectModel(DeliveryAssignment) private assign: typeof DeliveryAssignment,
    @InjectModel(Payment) private paymentModel: typeof Payment,
    @InjectModel(PaymentRefund) private paymentRefundModel: typeof PaymentRefund,
    @InjectModel(DeliveryPartner) private deliveryPartnerModel: typeof DeliveryPartner,
    private engine: DeliveryEngineService,
    private promotions: PromotionsService,
    private promoEngine: PromotionEngineService,
    private orchestrator: PricingOrchestrator,
    private giftCards: GiftCardService,
    private pricing: PricingService,
    @Inject(forwardRef(() => NotificationsService))
    private notifications: NotificationsService,
    @Inject(forwardRef(() => NotificationQueueService))
    private queueService: NotificationQueueService,
    @InjectModel(User) private userModel: typeof User,
    public eventEmitter: EventEmitter2,
    private readonly loyaltyService: LoyaltyService,
    private readonly wallet: WalletService,
    @InjectModel(Setting) private settingModel: typeof Setting,
  ) {}

  /**
   * Place an order. Idempotent on the `Idempotency-Key` header so a retried
   * POST never creates a duplicate order or double-decrements stock. Inventory
   * rows are locked FOR UPDATE inside the transaction and re-checked before
   * decrement, which makes overselling impossible under concurrency.
   */
  async create(userId: string, input: any, idemKey?: string | null) {
    // Cash on delivery places a real order: status PLACED, payment PENDING, no
    // gateway leg and no payment-hold expiry (expireUnpaidOrders only sweeps
    // PAYMENT_PENDING). Staff record the cash with POST payments/cod/confirm/:id
    // once the parcel is paid for.
    return withIdempotency(this.idem, { key: idemKey, endpoint: "orders.create", payload: { userId, ...input } }, () =>
      this.sequelize.transaction(async (t) => {
        let cart: Cart | null = null;
        let items: any[] = [];
        let variants: ProductVariant[] = [];

        if (input.buyNowVariantId) {
          if (input.buyNowQuantity !== undefined && input.buyNowQuantity <= 0) {
            throw new BadRequestException("Quantity must be greater than 0");
          }
          const v = await this.variant.findByPk(input.buyNowVariantId, {
            include: [{ model: Product, include: [ProductMedia] }],
            transaction: t
          });
          if (!v) throw new NotFoundException("NOT_FOUND", "Variant not found");
          if (!v.product || v.product.status !== "published") {
            throw new ForbiddenException("FORBIDDEN", "Product is not active or not published");
          }
          items = [{
            variantId: input.buyNowVariantId,
            quantity: input.buyNowQuantity || 1,
            priceSnapshot: Number(v.defaultPrice || 0),
          }];
          variants = [v];
        } else {
          cart = await this.cart.findOne({ where: { userId, status: "active" }, transaction: t });
          if (!cart) throw new CartEmptyException();
          items = await this.cartItem.findAll({ where: { cartId: cart.id }, transaction: t });
          if (!items.length) throw new CartEmptyException();

          // Fetch backend variants to ensure source-of-truth prices and snapshot data
          const variantIds = items.map(i => i.variantId);
          variants = await this.variant.findAll({
            where: { id: variantIds },
            include: [{ model: Product, include: [ProductMedia] }],
            transaction: t
          });

          // The same assertion the buy-now branch above makes. Without it the
          // two paths disagreed: a product withdrawn from the storefront could
          // not be bought directly, but could still be bought out of a cart it
          // had been added to earlier.
          const withdrawn = variants.find((v) => !v.product || v.product.status !== "published");
          if (withdrawn) {
            throw new ForbiddenException(
              "FORBIDDEN",
              `${withdrawn.product?.title ?? "An item in your cart"} is no longer available. Remove it to continue.`,
            );
          }
        }

        // Single-serving-shop: pin fulfilment to the serving shop the customer
        // checked out with (falls back to the shop the cart lines were pinned to).
        // Routing then fulfils/prices from THAT shop only — the price charged is the
        // price shown; if it's out of stock there, placement fails (no silent reroute).
        const pinnedShopId = input.shopId || (items as any[]).map((i) => i.shopId).find(Boolean) || undefined;

        // Buy-now lines carry no shopId (there is no cart to pin them). Stamp the pinned
        // serving shop so shop-scoped rules — notably BOGO's shop match — resolve the
        // same way they do for a normal cart checkout.
        for (const it of items as any[]) {
          if (!it.shopId && pinnedShopId) it.shopId = pinnedShopId;
        }

        const eta = await this.engine.estimate({
          lat: input.lat, lng: input.lng, express: input.express,
          items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
          preferredShopId: pinnedShopId,
        });

        // Compute subtotal using backend variant prices and inventory overrides from routing assignments
        let subtotal = 0;
        const assignmentItems: { variantId: string; quantity: number; shopId: string }[] = [];
        for (const a of eta.assignments) {
          for (const it of a.items) {
            assignmentItems.push({ variantId: it.variantId, quantity: it.quantity, shopId: a.shopId });
          }
        }

        // Fetch all inventory overrides for the assigned shops
        const inventories = await this.inv.findAll({
          where: {
            [Op.or]: assignmentItems.map(ai => ({ shopId: ai.shopId, variantId: ai.variantId }))
          },
          transaction: t
        });

        for (const item of items) {
          const assignment = assignmentItems.find(ai => ai.variantId === item.variantId);
          const v = variants.find(x => x.id === item.variantId);
          let unitPrice = Number(v?.defaultPrice || 0);
          if (assignment) {
            const inv = inventories.find(i => i.shopId === assignment.shopId && i.variantId === item.variantId);
            // `!= null`, the same test the order lines use when they are written
            // below (`priceOverride ?? defaultPrice`). A truthiness test here let
            // an override of 0 price the total and the lines differently.
            if (inv && inv.priceOverride != null) {
              unitPrice = Number(inv.priceOverride);
            }
          }
          subtotal += unitPrice * item.quantity;
          // Stamp the ACTUAL charged unit price back onto the line (buy-now lines carry
          // the variant default, not the shop override). Coupon eval and the Promotion
          // resolver both price off `priceSnapshot`, so they must see what is charged —
          // otherwise a promotion computes its discount on the wrong (lower) base.
          item.priceSnapshot = unitPrice;
        }

        // Discount + reward lines. Two paths, chosen by the Promotion Engine flag:
        //  • Flag OFF  → the LEGACY coupon-only path, byte-identical to before (no
        //    Promotion Engine involvement whatsoever).
        //  • Flag ON   → the PricingOrchestrator merges automatic promotions with the
        //    coupon (stacking rules §3.1/§3.2) and yields the same shape: a `discount`
        //    scalar + `rewardLines` (auto-added free/discounted OrderItems below).
        // `rewardLines` unifies promotion rewards and legacy coupon BOGO rewards.
        let discount = 0;
        let freeDelivery = false;
        let rewardLines: any[] = [];
        let bogoSavings = 0;      // legacy snapshot field (coupon-only path)
        let bogoRuleSnap: any = null;
        let promotionSnapshot: any = null;

        const engineEnabled = await this.promoEngine.isEnabled();
        if (engineEnabled) {
          const oc = await this.orchestrator.orchestrate({
            items,
            userId,
            shopId: pinnedShopId,
            couponCode: input.couponCode,
            paymentMethod: input.paymentMethod,
            deliveryMethod: input.express ? "Express" : "Standard",
            transaction: t, // race-safe promotion-limit enforcement at placement
          });
          discount = oc.totalDiscount;
          freeDelivery = oc.freeDelivery;
          rewardLines = oc.rewardLines;
          promotionSnapshot = {
            orchestrated: true,
            appliedPromotions: oc.appliedPromotions,
            coupon: oc.coupon ? { code: oc.coupon.code, type: oc.coupon.type } : null,
            promotionLineDiscount: oc.promotionLineDiscount,
            couponDiscount: oc.couponDiscount,
            stacking: oc.stacking,
            rewards: oc.rewardLines,
          };
        } else if (input.couponCode) {
          const evalResult = await this.promotions.evaluateCoupon(
            input.couponCode,
            subtotal,
            userId,
            items,
            input.paymentMethod,
            input.express ? "Express" : "Standard"
          );
          discount = evalResult.discount;
          freeDelivery = evalResult.freeDelivery;
          rewardLines = evalResult.bogoRewards ?? [];
          bogoSavings = evalResult.bogoSavings ?? 0;
          bogoRuleSnap = (evalResult.coupon as any)?.bogoRule ?? null;
        }

        // A reward is a real (discounted/free) goods line: fold its value into the
        // order subtotal so tax/total include it. For a 100%-off reward this adds ₹0.
        const bogoRewardValue = rewardLines.reduce(
          (s, r) => s + Number(r.unitPrice || 0) * Number(r.quantity || 0), 0,
        );
        subtotal += bogoRewardValue;

        // Fetch + validate the applied gift card. The cart stores the card id;
        // validateForCart takes the code, so resolve the card first.
        // NOTE: failures are NOT swallowed — an expired/disabled/unclaimed card
        // must stop checkout, otherwise the customer is silently charged full price.
        let gcBalance = 0;
        const appliedGiftCardId = input.giftCardId || (cart ? cart.giftCardId : null);

        if (appliedGiftCardId) {
          try {
            const gcDoc = await this.giftCards.getGiftCardDetails(appliedGiftCardId);
            await this.giftCards.validateForCart(gcDoc.code, userId, subtotal);
            gcBalance = Number(gcDoc.balance);
          } catch (e) {
            // Surface the real reason as a 4xx. The gift-card service throws
            // Nest's BadRequestException, which this app's filter renders as a
            // generic 500 — the customer must see WHY their card was rejected.
            // Checkout still stops: the card is never silently dropped.
            const reason = (e as any)?.response?.message ?? (e as Error)?.message ?? "This gift card cannot be used";
            throw new AppBadRequestException("VALIDATION_FAILED", String(reason));
          }
        }

        // Loyalty redemption (server-authoritative): convert requested points to a
        // capped discount. Points are locked here and deducted after order.create,
        // in the same transaction, so a redeem tx is always tied to the order.
        let loyaltyPointsToRedeem = 0;
        let loyaltyDiscount = 0;
        const requestedPoints = Math.floor(Number(input.loyaltyPoints || 0));
        if (requestedPoints > 0) {
          const pointValue = await this.pricing.loyaltyPointValue();
          const available = await this.loyaltyService.getAvailablePoints(userId, t);
          // Points can never discount more than the goods value after coupon.
          const maxByValue = Math.max(0, subtotal - discount);
          const maxPointsByValue = pointValue > 0 ? Math.floor(maxByValue / pointValue) : 0;
          loyaltyPointsToRedeem = Math.max(0, Math.min(requestedPoints, available, maxPointsByValue));
          loyaltyDiscount = loyaltyPointsToRedeem * pointValue;
        }

        // Delivery is priced on parcel weight against the destination zone — the
        // way the courier bills — not on distance to the shop. Distance still
        // chose which shop serves this order, a few lines above.
        //
        // One fee for the whole order, on the combined weight: a customer who
        // did not choose to have their order split across shops should not pay
        // twice for it.
        const isPickup = (input as any).pickup === true || (input as any).deliveryOption === "pickup";
        const parcel = computeParcelWeight(
          items.map((it: any) => ({ variantId: it.variantId, quantity: it.quantity })),
          variants,
          await this.pricing.packagingRules(),
        );
        if (parcel.missing.length) {
          // Not fatal — the fallback weight keeps checkout working — but these
          // products mis-price delivery until someone records their weight.
          this.logger.warn(`Order priced with fallback weight for variant(s): ${parcel.missing.join(", ")}`);
        }
        const shipState = (input.addressSnapshot as any)?.state ?? null;
        const { tax, deliveryFee, total, giftCardDiscount, payableAmount } = await this.pricing.compute(
          subtotal, discount, input.express, freeDelivery, gcBalance, loyaltyDiscount,
          { parcelG: parcel.chargeableG, state: shipState, isPickup }
        );

        // Apply wallet balance AFTER the gift card, to whatever remains payable.
        // `useWallet` applies as much as possible; `walletAmount` caps it (partial).
        let walletApplied = 0;
        if (input.useWallet || (input.walletAmount && input.walletAmount > 0)) {
          const { balance: walletBalance } = await this.wallet.getBalance(userId);
          const cap = input.walletAmount != null ? Number(input.walletAmount) : payableAmount;
          walletApplied = Math.max(0, Math.min(walletBalance, payableAmount, cap));
        }
        const netPayable = payableAmount - walletApplied;
        // Cash on delivery only while online payment is switched off (ONLINE_PAYMENTS_ENABLED=false).
        if (!env.ONLINE_PAYMENTS_ENABLED && input.paymentMethod !== PaymentMethod.COD && netPayable > 0) {
          throw new AppBadRequestException("BAD_REQUEST", "Online payment isn't available right now. Please choose Cash on Delivery.");
        }
        this.logger.debug(`Pricing: subtotal=${subtotal} total=${total} giftCard=${giftCardDiscount} wallet=${walletApplied} netPayable=${netPayable}`);

        let initialStatus = input.paymentMethod === PaymentMethod.COD ? OrderStatus.PLACED : OrderStatus.PAYMENT_PENDING;
        let initialPaymentStatus = PaymentStatus.PENDING;
        let effectivePaymentMethod = input.paymentMethod;

        // Stored value covers everything → no gateway, order is placed + captured
        // and the method reflects what actually paid (gift card / wallet), not the
        // gateway the customer happened to have selected.
        if (netPayable <= 0) {
           initialStatus = OrderStatus.PLACED;
           initialPaymentStatus = PaymentStatus.CAPTURED;
           effectivePaymentMethod = giftCardDiscount > 0 ? PaymentMethod.GIFT_CARD : PaymentMethod.WALLET;
        }

        const order = await this.order.create({
          orderNumber: this.pricing.orderNumber(), userId,
          // Null for Buy Now — those lines never came from the cart.
          cartId: cart?.id ?? null,
          status: initialStatus, subtotal, discount, tax, deliveryFee, total,
          // The scale reading behind `deliveryFee`. Without it, "why was
          // shipping ₹105?" is unanswerable once prices or packaging change.
          parcelWeightG: parcel.parcelG,
          couponCode: input.couponCode ?? null, paymentMethod: effectivePaymentMethod,
          paymentStatus: initialPaymentStatus,
          giftCardId: appliedGiftCardId,
          giftCardDiscount: giftCardDiscount,
          loyaltyDiscount: loyaltyDiscount,
          walletAmount: walletApplied,
          // The only amount a payment intent may charge.
          payableAmount: netPayable,
          addressSnapshot: input.addressSnapshot, deliveryOption: input.express ? "express" : "standard",
          placedAt: new Date(),
          // Freeze the applied BOGO rule + granted rewards for history/analytics.
          bogoSnapshot: rewardLines.length
            ? { couponCode: input.couponCode, rule: bogoRuleSnap, rewards: rewardLines, savings: bogoSavings }
            : null,
          // Full orchestrated snapshot (promotions + coupon + stacking) — engine ON only.
          promotionSnapshot,
        } as any, { transaction: t });

        // Deduct Gift Card Balance
        if (appliedGiftCardId && giftCardDiscount > 0) {
           await this.giftCards.deductBalance(appliedGiftCardId, giftCardDiscount, order.id, userId, t);
        }

        // Deduct wallet balance (within the same order transaction).
        if (walletApplied > 0) {
           await this.wallet.debit(userId, walletApplied, { orderId: order.id, reason: `Order ${order.orderNumber}` }, t);
        }

        // Deduct redeemed loyalty points (row-locked, writes a redeem tx tied to the order).
        if (loyaltyPointsToRedeem > 0) {
           await this.loyaltyService.redeemPoints(userId, loyaltyPointsToRedeem, order.id, t);
        }

        // Collect inventory alerts to emit AFTER the transaction commits
        const inventoryAlerts: { shopId: string; variantId: string; newQty: number; threshold: number; shopName: string }[] = [];
        // Collect created lines so we can persist their proportional allocation snapshot (§2).
        const createdItems: OrderItem[] = [];
        // Shipment per shop — reused when attaching BOGO free lines to the same shop.
        const shipmentsByShop = new Map<string, OrderShipment>();

        for (const a of eta.assignments) {
          const ship = await this.shipment.create({
            orderId: order.id, shopId: a.shopId, shipmentNumber: `${order.orderNumber}-${a.shopId.slice(0,4)}`,
            status: initialStatus,
            acceptDeadlineAt: new Date(Date.now() + 2*3600_000),
          } as any, { transaction: t });
          shipmentsByShop.set(a.shopId, ship);
          for (const it of a.items) {
            const ci = items.find((x) => x.variantId === it.variantId)!;
            // Lock the inventory row and re-verify stock before decrementing.
            const locked = await this.inv.findOne({
              where: { shopId: a.shopId, variantId: it.variantId },
              lock: t.LOCK.UPDATE, transaction: t,
            });
            if (!locked || locked.quantity < it.quantity) {
              throw new OutOfStockException({ variantId: it.variantId, shopId: a.shopId });
            }
            
            const v = variants.find(x => x.id === it.variantId);
            const unitPrice = Number(locked?.priceOverride ?? v?.defaultPrice ?? 0);
            const sub = unitPrice * it.quantity;
            
            const createdItem = await this.orderItem.create({
              shipmentId: ship.id,
              variantId: it.variantId,
              shopId: a.shopId,
              quantity: it.quantity,
              price: unitPrice,
              unitPrice: unitPrice,
              subtotal: sub,
              productId: v?.product?.id,
              productName: v?.product?.title,
              productImage: v?.product?.media?.[0]?.url || "/placeholder/product.svg",
              sku: v?.sku,
              variantAttributes: v?.attributes
            } as any, { transaction: t });
            createdItems.push(createdItem);
            
            await this.routing.create({ orderId: order.id, variantId: it.variantId, chosenShopId: a.shopId, distanceKm: a.distanceKm, zone: a.zone, reason: "Closest shop with stock" } as any, { transaction: t });
            await locked.decrement("quantity", { by: it.quantity, transaction: t });
            
            // --- INVENTORY THRESHOLD CHECK (after every stock deduction) ---
            const newQty = locked.quantity - it.quantity;
            const threshold = locked.lowStockThreshold ?? 5;
            if (newQty <= threshold) {
              inventoryAlerts.push({
                shopId: a.shopId,
                variantId: it.variantId,
                newQty,
                threshold,
                shopName: a.shopName || "a shop",
              });
            }

            await this.mov.create({
              shopId: a.shopId,
              variantId: it.variantId,
              type: "SALE",
              quantity: it.quantity,
              reason: "Order Placed",
              referenceType: "ORDER",
              referenceId: order.orderNumber,
              createdBy: userId,
            } as any, { transaction: t });
          }
        }

        // ── Reward free items (BOGO coupon OR automatic promotion) ───────────────
        // Materialise each earned reward as a real free/discounted OrderItem, deduct its
        // stock (row-locked, re-checked → no overselling), and record a SALE movement.
        // The free item is auto-added here — the customer never adds it manually.
        if (rewardLines.length) {
          const rewardVariantIds = Array.from(new Set(rewardLines.map((r) => r.variantId)));
          const rewardVariants = await this.variant.findAll({
            where: { id: rewardVariantIds },
            include: [{ model: Product, include: [ProductMedia] }],
            transaction: t,
          });

          for (const reward of rewardLines) {
            const shopId = reward.shopId || pinnedShopId;
            if (!shopId) throw new AppBadRequestException("VALIDATION_FAILED", "Reward item has no fulfilment shop.");

            // Reuse the shop's shipment, or open one if the reward ships from a shop
            // that had no purchased lines.
            let ship = shipmentsByShop.get(shopId);
            if (!ship) {
              ship = await this.shipment.create({
                orderId: order.id, shopId, shipmentNumber: `${order.orderNumber}-${shopId.slice(0, 4)}`,
                status: initialStatus,
                acceptDeadlineAt: new Date(Date.now() + 2 * 3600_000),
              } as any, { transaction: t });
              shipmentsByShop.set(shopId, ship);
            }

            // Lock + re-verify the free item's stock. Out of stock → clear 4xx so the
            // customer is told the offer can't be honoured (never silently dropped).
            const locked = await this.inv.findOne({
              where: { shopId, variantId: reward.variantId },
              lock: t.LOCK.UPDATE, transaction: t,
            });
            if (!locked || locked.quantity < reward.quantity) {
              throw new AppBadRequestException(
                "VALIDATION_FAILED",
                "The free item for this Buy-X-Get-Y offer is out of stock at your store, so the offer cannot be applied.",
              );
            }

            const rv = rewardVariants.find((x) => x.id === reward.variantId);
            const unitPrice = Number(reward.unitPrice || 0);
            const freeItem = await this.orderItem.create({
              shipmentId: ship.id,
              variantId: reward.variantId,
              shopId,
              quantity: reward.quantity,
              price: unitPrice,
              unitPrice: unitPrice,
              subtotal: unitPrice * reward.quantity,
              productId: rv?.product?.id,
              productName: rv?.product?.title || reward.productName,
              productImage: rv?.product?.media?.[0]?.url || reward.productImage || "/placeholder/product.svg",
              sku: rv?.sku,
              variantAttributes: rv?.attributes,
              isFree: true,
              isBogo: true,
              bogoParentVariantId: reward.parentVariantId,
              // Present when the reward came from an automatic promotion (Phase 3).
              promotionId: reward.promotionId ?? null,
              appliedPromotionType: reward.promotionId ? "reward" : null,
            } as any, { transaction: t });
            createdItems.push(freeItem);

            await this.routing.create({
              orderId: order.id, variantId: reward.variantId, chosenShopId: shopId,
              distanceKm: 0, zone: null, reason: "BOGO free item",
            } as any, { transaction: t });
            await locked.decrement("quantity", { by: reward.quantity, transaction: t });

            const newQty = locked.quantity - reward.quantity;
            const threshold = locked.lowStockThreshold ?? 5;
            if (newQty <= threshold) {
              inventoryAlerts.push({
                shopId, variantId: reward.variantId, newQty, threshold,
                shopName: eta.assignments.find((a: any) => a.shopId === shopId)?.shopName || "a shop",
              });
            }

            await this.mov.create({
              shopId, variantId: reward.variantId, type: "SALE",
              quantity: reward.quantity, reason: "BOGO Free Item",
              referenceType: "ORDER", referenceId: order.orderNumber, createdBy: userId,
            } as any, { transaction: t });
          }
        }

        // Persist the per-line allocation snapshot (§2). Uses the order's STORED split so
        // each line's lineRefundableBase (= wallet + cash share) sums exactly to
        // order.walletAmount + order.payableAmount — what the refund engine treats as refundable.
        const allocations = computeLineAllocations(
          createdItems.map((ci) => ({ id: ci.id, price: Number(ci.price), quantity: Number(ci.quantity) })),
          {
            discount: Number(order.discount || 0),
            loyaltyDiscount: Number(order.loyaltyDiscount || 0),
            giftCardDiscount: Number(order.giftCardDiscount || 0),
            tax: Number(order.tax || 0),
            deliveryFee: Number(order.deliveryFee || 0),
            walletAmount: Number(order.walletAmount || 0),
            payableAmount: Number(order.payableAmount || 0),
          },
        );
        for (const ci of createdItems) {
          const al = allocations.get(ci.id);
          if (al) await ci.update({ ...al, refundedAmount: 0 } as any, { transaction: t });
        }

        await this.history.create({ orderId: order.id, status: initialStatus, notes: "Order placed", actorId: userId } as any, { transaction: t });
        // Empty the cart only when the order is already settled: COD, or fully
        // covered by gift card / wallet. An order still owing a gateway payment
        // keeps its cart — the customer may dismiss the Razorpay sheet, and the
        // items must still be there to retry or switch to COD. Those carts are
        // converted from PaymentsService.captureVerifiedPayment() once the money
        // actually lands.
        const settledAtPlacement =
          initialPaymentStatus === PaymentStatus.CAPTURED || effectivePaymentMethod === PaymentMethod.COD;
        if (cart && settledAtPlacement) {
          await cart.update({ status: "converted" }, { transaction: t });
        }

        // Record coupon redemption so per-user / global usage limits are enforced.
        if (input.couponCode) await this.promotions.recordRedemption(input.couponCode, userId, order.id, t);

        // Promotion redemption ledger (Phase B) — one row per applied promotion, for fast
        // indexed analytics + usage counting + future limits. Reward promos carry their
        // savings/qty; line promos carry the order's line discount.
        if (promotionSnapshot?.appliedPromotions?.length) {
          const rewards: any[] = promotionSnapshot.rewards || [];
          const LINE = new Set(["flash", "festival", "category", "cart", "auto"]);
          for (const ap of promotionSnapshot.appliedPromotions) {
            const rw = rewards.filter((r) => r.promotionId === ap.id);
            const rewardQty = rw.reduce((s, r) => s + Number(r.quantity || 0), 0);
            const rewardSaved = rw.reduce((s, r) => s + (Number(r.unitPriceBefore || 0) - Number(r.unitPrice || 0)) * Number(r.quantity || 0), 0);
            const lineSaved = LINE.has(ap.type) ? Number(promotionSnapshot.promotionLineDiscount || 0) : 0;
            // Only ledger a redemption that actually delivered value — skips promotions
            // that "applied" but granted nothing (e.g. deduped identical reward promos).
            if (rewardSaved + lineSaved <= 0 && rewardQty <= 0) continue;
            await this.promoRedemptionModel.create({
              promotionId: ap.id, orderId: order.id, userId,
              shopId: rw[0]?.shopId || pinnedShopId || null,
              savedAmount: rewardSaved + lineSaved, rewardQuantity: rewardQty, promotionType: ap.type,
            } as any, { transaction: t });
          }
        }

        // Loyalty points are intentionally omitted here. They are earned strictly post-capture.

        t.afterCommit(() => {
          // Detached on purpose. Sequelize awaits afterCommit hooks inside
          // commit(), so slow work here delays the response and work that
          // hangs — an unreachable queue, say — hangs the whole operation.
          void (async () => {
          const shopIds = eta.assignments.map((a: any) => a.shopId);
          const shopNames = Array.from(new Set(eta.assignments.map((a: any) => a.shopName || "a shop"))).join(", ");
          
          if (input.paymentMethod === PaymentMethod.COD) {
            // Queue NEW_ORDER notifications asynchronously
            // A signed tracking link, so a customer who checked out with an OTP
            // and never signs back in can still follow the order. Only worth
            // sending when there is a real mailbox to send it to.
            const buyer = await this.userModel.findByPk(userId);
            const trackUrl = isDeliverableEmail(buyer?.email) ? orderTrackingUrl(order.id) : undefined;
            await this.queueService.enqueue(userId, NotificationEventType.NEW_ORDER, {
              orderNumber: order.orderNumber,
              shopName: shopNames,
              trackUrl,
              // The buyer's copy is worded as a confirmation, not a work order.
              audience: "customer",
              amount: Number(order.payableAmount ?? order.total),
            });
            
            const managers = await this.userModel.findAll({ where: { role: Role.SHOP_MANAGER, shopId: { [Op.in]: Array.from(shopIds) } } });
            for (const m of managers) {
              const mShopName = eta.assignments.find((a: any) => a.shopId === m.shopId)?.shopName || "your shop";
              await this.queueService.enqueue(m.id, NotificationEventType.NEW_ORDER, { orderNumber: order.orderNumber, shopName: mShopName });
            }
            
            this.eventEmitter.emit("admin.notify", {
              eventType: NotificationEventType.NEW_ORDER,
              variables: { orderNumber: order.orderNumber, shopName: shopNames }
            });
            
            for (const shopId of shopIds) {
              this.notifications.broadcastShipmentCreated(shopId, {
                orderNumber: order.orderNumber,
              });
            }
          } else {
            // Online payment pending: Queue a delayed job to expire/release inventory hold
            const delayMs = Number(env.PAYMENT_HOLD_MINUTES || 20) * 60 * 1000;
            await this.queueService.enqueue(
              userId,
              NotificationEventType.PAYMENT_FAILED,
              { orderId: order.id, orderNumber: order.orderNumber },
              { delay: delayMs }
            );

            this.eventEmitter.emit("admin.notify", {
              eventType: NotificationEventType.PAYMENT_PENDING,
              variables: { orderNumber: order.orderNumber, amount: Number(order.total) }
            });

            const managers = await this.userModel.findAll({ where: { role: Role.SHOP_MANAGER, shopId: { [Op.in]: Array.from(shopIds) } } });
            for (const m of managers) {
              const mShopName = eta.assignments.find((a: any) => a.shopId === m.shopId)?.shopName || "your shop";
              await this.queueService.enqueue(m.id, NotificationEventType.PAYMENT_PENDING, { orderNumber: order.orderNumber, shopName: mShopName });
            }
          }

          // --- Enterprise Triggers ---
          const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);
          
          if (order.total >= 10000) {
            this.eventEmitter.emit("admin.notify", {
              eventType: NotificationEventType.HIGH_VALUE_ORDER,
              variables: { orderNumber: order.orderNumber, total: order.total }
            });
          }
          if (totalQty >= 50) {
            this.eventEmitter.emit("admin.notify", {
              eventType: NotificationEventType.LARGE_QTY_ORDER,
              variables: { orderNumber: order.orderNumber, qty: totalQty }
            });
          }

          // --- INVENTORY ALERTS (emit after commit to avoid false alarms) ---
          for (const alert of inventoryAlerts) {
            const eventType = alert.newQty === 0
              ? NotificationEventType.OUT_OF_STOCK
              : NotificationEventType.LOW_STOCK;

            // Notify Shop Manager
            const managers = await this.userModel.findAll({
              where: { role: Role.SHOP_MANAGER, shopId: alert.shopId },
            });
            for (const mgr of managers) {
              await this.queueService.enqueue(mgr.id, eventType, {
                productId: alert.variantId,
                shopId: alert.shopId,
                shopName: alert.shopName,
                quantity: alert.newQty,
                threshold: alert.threshold,
              });
            }

            // Notify all Admins
            this.eventEmitter.emit("admin.notify", {
              eventType,
              variables: {
                productId: alert.variantId,
                shopId: alert.shopId,
                shopName: alert.shopName,
                quantity: alert.newQty,
                threshold: alert.threshold,
              },
            });
          }

        })().catch((err) =>
            this.logger.error(`Post-commit work failed: ${(err as Error).message}`),
          );
        });

        return { order, eta };
      }),
    );
  }

  /**
   * Give back whatever stored value an order consumed — gift card balance and
   * wallet balance. Used when an order is cancelled and when an unpaid online
   * order expires, so a customer never loses balance for an order that never
   * completed. Both underlying calls write their own ledger entries.
   */
  private async restoreStoredValue(order: Order, actorId: string | null, reason: string, t: Transaction) {
    if (order.giftCardId && Number(order.giftCardDiscount) > 0) {
      await this.giftCards.refundBalance(
        order.giftCardId, Number(order.giftCardDiscount), order.id, actorId, reason, t,
      );
    }
    if (Number(order.walletAmount) > 0) {
      await this.wallet.credit(order.userId, Number(order.walletAmount), {
        type: "refund",
        orderId: order.id,
        reason,
        // One restore per order, even if this runs twice (cancel + expiry sweep).
        idempotencyKey: `order-restore-${order.id}`,
      }, t);
    }
  }

  /**
   * Expire online orders that were never paid: the gift card / wallet was debited
   * at placement, so an abandoned checkout would otherwise strand the balance.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireUnpaidOrders(): Promise<{ expired: number }> {
    const cutoff = new Date(Date.now() - (env.PAYMENT_HOLD_MINUTES ?? 20) * 60_000);
    const stale = await this.order.findAll({
      where: {
        status: OrderStatus.PAYMENT_PENDING,
        paymentStatus: PaymentStatus.PENDING,
        placedAt: { [Op.lt]: cutoff },
      },
      limit: 50,
    });

    let expired = 0;
    for (const stub of stale) {
      try {
        await this.sequelize.transaction(async (t) => {
          const order = await this.order.findByPk(stub.id, { lock: t.LOCK.UPDATE, transaction: t });
          // Re-check under the lock — it may have been paid or cancelled meanwhile.
          if (!order || order.status !== OrderStatus.PAYMENT_PENDING || order.paymentStatus !== PaymentStatus.PENDING) return;

          // The full cancellation path: it puts the stock back, releases the
          // coupon and promotion usage, returns stored value and redeemed points.
          // This used to restore only the stored value, so every abandoned online
          // payment kept its units off the shelf for good.
          const shipments = await this.shipment.findAll({ where: { orderId: order.id }, lock: t.LOCK.UPDATE, transaction: t });
          const open = shipments.filter((sh) => sh.status !== OrderStatus.CANCELLED);
          await this.executeFulfillmentCancellation(t, order, open, null, "Payment not completed — order expired");
          await order.update({ status: OrderStatus.FAILED, paymentStatus: PaymentStatus.FAILED }, { transaction: t });
          expired++;
        });
      } catch (e) {
        this.logger.error(`Failed to expire unpaid order ${stub.id}: ${(e as Error).message}`);
      }
    }
    if (expired) this.logger.log(`Expired ${expired} unpaid order(s) and restored their stored value`);
    return { expired };
  }

  async cancel(userId: string, orderId: string, reason?: string) {
    return this.sequelize.transaction(async (t) => {
      const order = await this.order.findOne({
        where: { id: orderId, userId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");
      
      if (order.status === OrderStatus.CANCELLED) {
        throw new ConflictException("ORDER_ALREADY_CANCELLED", "Order is already cancelled");
      }
      if (order.status === OrderStatus.CANCEL_REQUESTED) {
        throw new ConflictException("CONFLICT", "Order cancellation has already been requested and is in progress");
      }

      const shipments = await this.shipment.findAll({
        where: { orderId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });

      const hasShippedOrLater = shipments.some(s => 
        [OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED].includes(s.status)
      );
      if (hasShippedOrLater) {
        throw new CancellationWindowExpiredException();
      }

      const hasPacked = shipments.some(s => s.status === OrderStatus.PACKED);
      if (hasPacked) {
        const oldOrderStatus = order.status;
        await order.update({ status: OrderStatus.CANCEL_REQUESTED }, { transaction: t });
        await this.history.create({ orderId, status: OrderStatus.CANCEL_REQUESTED, notes: reason || "Customer requested cancellation", actorId: userId } as any, { transaction: t });
        
        for (const s of shipments) {
          if ([OrderStatus.PLACED, OrderStatus.CONFIRMED, OrderStatus.PACKED].includes(s.status)) {
            await s.update({ status: OrderStatus.CANCEL_REQUESTED }, { transaction: t });
            await this.history.create({ shipmentId: s.id, status: OrderStatus.CANCEL_REQUESTED, notes: reason || "Customer requested cancellation", actorId: userId } as any, { transaction: t });
          }
        }

        await OrderShipment.deriveAndUpdateOrderStatus(order.id, t);

        await this.auditLogModel.create({
          actorId: userId,
          action: "cancel_requested",
          entity: "Order",
          entityId: order.id,
          before: { status: oldOrderStatus },
          after: { status: OrderStatus.CANCEL_REQUESTED }
        } as any, { transaction: t });

        t.afterCommit(() => {
          // Detached on purpose. Sequelize awaits afterCommit hooks inside
          // commit(), so slow work here delays the response and work that
          // hangs — an unreachable queue, say — hangs the whole operation.
          void (async () => {
          const shopIds = [...new Set(shipments.map(s => s.shopId))];
          await this.notifications.notifyShopManagers(shopIds, "Cancellation requested ⚠️", `Customer has requested cancellation for order ${order.orderNumber}.`);
        })().catch((err) =>
            this.logger.error(`Post-commit work failed: ${(err as Error).message}`),
          );
        });

        return order;
      } else {
        await this.executeFulfillmentCancellation(t, order, shipments, userId, reason || "Customer cancelled order");
        return order;
      }
    });
  }

  async adminCancel(orderId: string, reason?: string, adminId?: string, scopeShopId?: string | null) {
    return this.sequelize.transaction(async (t) => {
      const order = await this.order.findOne({
        where: { id: orderId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");

      if (order.status === OrderStatus.CANCELLED) {
        throw new ConflictException("ORDER_ALREADY_CANCELLED", "Order is already cancelled");
      }

      const shipments = await this.shipment.findAll({
        where: { orderId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      // A shop account may cancel only an order its own shop fulfils entirely;
      // cancelling cancels every shipment, other shops' included. Same answer
      // as a missing order, so order ids cannot be probed across shops.
      if (scopeShopId && shipments.some((s) => s.shopId !== scopeShopId)) {
        throw new NotFoundException("NOT_FOUND", "Order not found");
      }

      // Delivered goods are a return, not a cancellation: cancelling refunded the
      // full amount and restocked units the customer still has.
      if (shipments.some((s) => DELIVERED_STATES.includes(s.status))) {
        throw new ConflictException("CONFLICT", "This order has been delivered — raise a return instead of cancelling it.");
      }

      await this.executeFulfillmentCancellation(t, order, shipments, adminId || null, reason || "Admin force cancelled order");
      return { success: true };
    });
  }

  async managerCancel(u: JwtPayload, shipmentId: string, reason?: string) {
    return this.sequelize.transaction(async (t) => {
      const shipment = await this.shipment.findOne({
        where: { id: shipmentId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!shipment) throw new NotFoundException("NOT_FOUND", "Shipment not found");
      
      if (u.role === Role.SHOP_MANAGER && shipment.shopId !== u.shopId) {
        throw new ForbiddenException("AUTH_FORBIDDEN", "You do not have permission to act on this shipment");
      }

      if (shipment.status === OrderStatus.CANCELLED) {
        throw new ConflictException("CONFLICT", "Shipment is already cancelled");
      }
      if (DELIVERED_STATES.includes(shipment.status)) {
        throw new ConflictException("CONFLICT", "This shipment has been delivered — raise a return instead of cancelling it.");
      }

      const order = await this.order.findOne({
        where: { id: shipment.orderId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");

      await this.executeFulfillmentCancellation(t, order, [shipment], u.sub, reason || "Shop Manager cancelled shipment");
      return { success: true };
    });
  }

  async approveCancellationRequest(u: JwtPayload, shipmentId: string, reason?: string) {
    return this.sequelize.transaction(async (t) => {
      const shipment = await this.shipment.findOne({
        where: { id: shipmentId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!shipment) throw new NotFoundException("NOT_FOUND", "Shipment not found");
      
      if (u.role === Role.SHOP_MANAGER && shipment.shopId !== u.shopId) {
        throw new ForbiddenException("AUTH_FORBIDDEN", "You do not have permission to act on this shipment");
      }

      if (shipment.status !== OrderStatus.CANCEL_REQUESTED) {
        throw new ConflictException("CONFLICT", `Shipment is not in cancel_requested status (current status: ${shipment.status})`);
      }

      const order = await this.order.findOne({
        where: { id: shipment.orderId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");

      await this.executeFulfillmentCancellation(t, order, [shipment], u.sub, reason || "Shop Manager approved cancellation request");
      return { success: true };
    });
  }

  async rejectCancellationRequest(u: JwtPayload, shipmentId: string, reason?: string) {
    return this.sequelize.transaction(async (t) => {
      const shipment = await this.shipment.findOne({
        where: { id: shipmentId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!shipment) throw new NotFoundException("NOT_FOUND", "Shipment not found");
      
      if (u.role === Role.SHOP_MANAGER && shipment.shopId !== u.shopId) {
        throw new ForbiddenException("AUTH_FORBIDDEN", "You do not have permission to act on this shipment");
      }

      if (shipment.status !== OrderStatus.CANCEL_REQUESTED) {
        throw new ConflictException("CONFLICT", `Shipment is not in cancel_requested status (current status: ${shipment.status})`);
      }

      const order = await this.order.findOne({
        where: { id: shipment.orderId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");

      const oldStatus = shipment.status;
      await shipment.update({ status: OrderStatus.PACKED }, { transaction: t });
      await this.history.create({
        shipmentId: shipment.id,
        status: OrderStatus.PACKED,
        notes: reason || "Shop Manager rejected cancellation request",
        actorId: u.sub
      } as any, { transaction: t });

      await OrderShipment.deriveAndUpdateOrderStatus(order.id, t);

      await this.auditLogModel.create({
        actorId: u.sub,
        action: "reject_cancellation",
        entity: "OrderShipment",
        entityId: shipment.id,
        before: { status: oldStatus },
        after: { status: OrderStatus.PACKED }
      } as any, { transaction: t });

      t.afterCommit(() => {
        // Detached on purpose. Sequelize awaits afterCommit hooks inside
        // commit(), so slow work here delays the response and work that
        // hangs — an unreachable queue, say — hangs the whole operation.
        void (async () => {
        await this.notifications.notify(order.userId, "Cancellation request rejected 📦", `Fulfillment of your order ${order.orderNumber} is proceeding.`, "all", `/my-orders/${order.id}`);
      })().catch((err) =>
          this.logger.error(`Post-commit work failed: ${(err as Error).message}`),
        );
      });

      return { success: true };
    });
  }

  async executeFulfillmentCancellation(
    t: any,
    order: Order,
    shipmentsToCancel: OrderShipment[],
    actorId: string | null,
    reason?: string
  ) {
    for (const s of shipmentsToCancel) {
      const oldStatus = s.status;
      await s.update({ status: OrderStatus.CANCELLED }, { transaction: t });
      await this.history.create({
        shipmentId: s.id,
        status: OrderStatus.CANCELLED,
        notes: reason || "Shipment cancelled",
        actorId
      } as any, { transaction: t });

      await this.assign.update(
        { status: "cancelled" },
        {
          where: {
            shipmentId: s.id,
            status: { [Op.in]: ["offered", "accepted", "picked"] }
          },
          transaction: t
        }
      );

      const oitems = await this.orderItem.findAll({ where: { shipmentId: s.id }, transaction: t });
      for (const it of oitems) {
        const lockedInv = await this.inv.findOne({
          where: { shopId: it.shopId, variantId: it.variantId },
          lock: t.LOCK.UPDATE,
          transaction: t
        });
        if (lockedInv) {
          await lockedInv.increment("quantity", { by: it.quantity, transaction: t });
        }
        await this.mov.create({
          shopId: it.shopId,
          variantId: it.variantId,
          type: "SALE_CANCEL",
          quantity: it.quantity,
          reason: "Order Cancelled",
          referenceType: "ORDER",
          referenceId: order.orderNumber,
          createdBy: actorId,
        } as any, { transaction: t });
      }

      await this.auditLogModel.create({
        actorId,
        action: "cancel_shipment",
        entity: "OrderShipment",
        entityId: s.id,
        before: { status: oldStatus },
        after: { status: OrderStatus.CANCELLED }
      } as any, { transaction: t });
    }

    const allShipments = await this.shipment.findAll({ where: { orderId: order.id }, transaction: t });
    const allCancelled = allShipments.every(s => s.status === OrderStatus.CANCELLED);

    let paymentRefundId: string | null = null;
    let paymentToRefund: Payment | null = null;
    let cancelRefundAmount = 0;

    const oldOrderStatus = order.status;
    await OrderShipment.deriveAndUpdateOrderStatus(order.id, t);

    if (allCancelled) {
      await this.history.create({
        orderId: order.id,
        status: OrderStatus.CANCELLED,
        notes: reason || "Order cancelled",
        actorId
      } as any, { transaction: t });

      if (order.couponCode) {
        await this.promotions.rollbackRedemption(order.id, t);
      }

      // HP3: reverse this order's promotion redemptions so analytics/usage-counts no longer
      // include a fully-cancelled order. Historical completed orders are unaffected.
      await this.promoRedemptionModel.destroy({ where: { orderId: order.id }, transaction: t });

      await this.restoreStoredValue(order, actorId, reason || "Order cancelled", t);

      // Rollback earned points if any
      await this.loyaltyService.rollbackEarnedPoints(order.userId, order.id, t);

      // Restore any loyalty points the customer redeemed on this order
      await this.loyaltyService.refundRedeemedPoints(order.userId, order.id, t);

      if (order.paymentMethod !== PaymentMethod.COD) {
        paymentToRefund = await this.paymentModel.findOne({
          where: { orderId: order.id, status: "captured" },
          transaction: t
        });
        if (paymentToRefund) {
          // The gateway refund is the cash leg only. Gift card and wallet are
          // returned by restoreStoredValue above; refunding order.total as well
          // paid them back twice. And never more than is still unrefunded on
          // the payment: refunds already issued (or in flight) for a return or
          // a dispute used to be ignored here, so cancelling refunded them twice.
          const prior = (await this.paymentRefundModel.findAll({
            where: { paymentId: paymentToRefund.id, status: ["pending", "processing", "succeeded"] as any },
            attributes: ["amount"], transaction: t,
          })).reduce((sum, r) => sum + Number(r.amount), 0);
          cancelRefundAmount = Math.max(0, Math.min(Number(order.payableAmount ?? order.total), Number(paymentToRefund.amount) - prior));
        }
        if (paymentToRefund && cancelRefundAmount > 0) {
          const refundObj = await this.paymentRefundModel.create({
            paymentId: paymentToRefund.id,
            amount: cancelRefundAmount,
            reason: reason || "Order cancelled",
            status: "pending"
          } as any, { transaction: t });
          paymentRefundId = refundObj.id;
        }
      }

      await this.auditLogModel.create({
        actorId,
        action: "cancel_order",
        entity: "Order",
        entityId: order.id,
        before: { status: oldOrderStatus },
        after: { status: OrderStatus.CANCELLED }
      } as any, { transaction: t });
    }

    t.afterCommit(() => {
      // Detached on purpose. Sequelize awaits afterCommit hooks inside
      // commit(), so slow work here delays the response and work that
      // hangs — an unreachable queue, say — hangs the whole operation.
      void (async () => {
      if (paymentRefundId && paymentToRefund) {
        try {
          const res = await paymentProvider.refund(paymentToRefund.gatewayRef ?? paymentToRefund.id, cancelRefundAmount);
          await this.paymentRefundModel.update(
            { refundRef: res.refundRef },
            { where: { id: paymentRefundId } }
          );
        } catch (err: any) {
          await this.paymentRefundModel.update(
            { status: "failed", reason: `Gateway initiation failed: ${err.message}` },
            { where: { id: paymentRefundId } }
          );
        }
      }

      if (allCancelled) {
        await this.notifications.notify(order.userId, "Order cancelled ❌", `Your order ${order.orderNumber} has been cancelled.`, "all", `/my-orders/${order.id}`);
      } else {
        await this.notifications.notify(order.userId, "Shipment updated 📦", `One or more shipments of your order ${order.orderNumber} have been cancelled.`, "all", `/my-orders/${order.id}`);
      }

      const shopIds = [...new Set(shipmentsToCancel.map(s => s.shopId))];
      await this.notifications.notifyShopManagers(shopIds, "Shipment cancelled", `Shipment(s) under order ${order.orderNumber} have been cancelled.`);

      this.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.ORDER_CANCELLED,
        variables: { orderNumber: order.orderNumber, reason: reason || "Cancelled" }
      });

      for (const s of shipmentsToCancel) {
        if (s.deliveryPartnerId) {
          const partnerObj = await this.deliveryPartnerModel.findByPk(s.deliveryPartnerId);
          if (partnerObj?.userId) {
            await this.notifications.notify(
              partnerObj.userId,
              "Delivery assignment cancelled 🛵",
              `Delivery assignment for shipment ${s.shipmentNumber} has been cancelled.`
            );
          }
        }
      }
    })().catch((err) =>
        this.logger.error(`Post-commit work failed: ${(err as Error).message}`),
      );
    });
  }

  async reorder(userId: string, orderId: string) {
    // Only the caller's own order. Without this any order id copied its lines
    // into the caller's cart, which told them what someone else had bought.
    // "Not yours" answers exactly like "no such order", so ids can't be probed.
    const owned = await this.order.findOne({ where: { id: orderId, userId }, attributes: ["id"] });
    if (!owned) throw new NotFoundException("NOT_FOUND", "Order not found");

    const ships = await this.shipment.findAll({ where: { orderId } });
    const items = await this.orderItem.findAll({ where: { shipmentId: ships.map((s) => s.id) } });
    const [cart] = await this.cart.findOrCreate({ where: { userId, status: "active" }, defaults: { userId, status: "active" } as any });
    for (const it of items) {
      const v = await this.variant.findByPk(it.variantId);
      if (v) await this.cartItem.create({ cartId: cart.id, variantId: it.variantId, quantity: it.quantity, priceSnapshot: v.defaultPrice } as any);
    }
    return { added: items.length };
  }

  /**
   * Generate and return a real invoice for the order. Produces a PDF
   * document dynamically, persists it to storage, and stores the public URL.
   */
  /* ──────────────────── Guest order tracking (public) ────────────────────
   * Customers who checked out with an OTP have an account but often never sign
   * back in, so they need a way to see an order from a cold browser. Both
   * entry points below are unauthenticated, which shapes everything about
   * them: they answer with a cut-down projection, they never distinguish
   * "no such order" from "wrong contact", and they are throttled at the
   * controller. Treat any change here as a change to an anonymous surface.
   */

  /** Same answer for every failure, so the two cases cannot be probed apart. */
  private lookupMiss(): never {
    throw new NotFoundException("NOT_FOUND", "We couldn't find an order matching those details.");
  }

  /** Last 10 digits, so "+91 98765 43210" and "9876543210" compare equal. */
  private static phoneKey(raw?: string | null): string {
    return (raw || "").replace(/\D/g, "").slice(-10);
  }

  /**
   * Look an order up by the number on the confirmation plus the phone or email
   * it was placed with. Both halves must match: an order number alone is a weak
   * secret, and the contact is what shows the asker is the customer.
   */
  async lookupByNumber(orderNumber: string, contact: string) {
    const number = orderNumber.trim().toUpperCase();
    const order = await this.order.findOne({
      where: { orderNumber: number },
      include: [{ model: User, attributes: ["email", "phone"] }],
    });
    if (!order) this.lookupMiss();

    const given = contact.trim().toLowerCase();
    const givenPhone = OrdersService.phoneKey(contact);
    const email = (order.user?.email || "").toLowerCase();
    const phone = OrdersService.phoneKey(order.user?.phone);

    const matches = (!!email && email === given) || (givenPhone.length === 10 && !!phone && phone === givenPhone);
    if (!matches) this.lookupMiss();

    return this.publicOrderView(order);
  }

  /** Look an order up from the signed link in a confirmation email. */
  async lookupByToken(token: string) {
    const orderId = readOrderLookupToken(token);
    if (!orderId) this.lookupMiss();
    const order = await this.order.findByPk(orderId);
    if (!order) this.lookupMiss();
    return this.publicOrderView(order);
  }

  /**
   * The only order shape an anonymous caller ever sees.
   *
   * Built by naming fields rather than by trimming a full order, so a column
   * added later stays private by default. The delivery address in particular is
   * never included: holding an order number must not reveal where it is going.
   */
  private async publicOrderView(order: Order) {
    const shipments = await this.shipment.findAll({
      where: { orderId: order.id },
      attributes: ["id", "shipmentNumber", "status", "trackingNumber", "dispatchedAt", "deliveredAt"],
      include: [{ model: OrderItem, attributes: ["productName", "quantity", "unitPrice", "price"] }],
    });
    // Status and time only — the notes are staff-facing. Order-level rows
    // ("placed", written before any shipment acts) apply to every shipment.
    const timeline = shipments.length
      ? await this.history.findAll({
          where: { [Op.or]: [{ shipmentId: shipments.map((sh) => sh.id) }, { orderId: order.id, shipmentId: null }] },
          attributes: ["id", "shipmentId", "status", "createdAt"],
          order: [["createdAt", "ASC"]],
        })
      : [];

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      placedAt: order.placedAt,
      total: order.total,
      shipments: shipments.map((sh: any) => ({
        id: sh.id,
        shipmentNumber: sh.shipmentNumber,
        status: sh.status,
        trackingNumber: sh.trackingNumber,
        dispatchedAt: sh.dispatchedAt,
        deliveredAt: sh.deliveredAt,
        items: (sh.items || []).map((it: any) => ({
          title: it.productName ?? "Item",
          quantity: it.quantity,
          price: it.unitPrice ?? it.price ?? null,
        })),
        history: timeline
          .filter((h: any) => h.shipmentId === sh.id || h.shipmentId == null)
          .map((h: any) => ({ id: h.id, shipmentId: sh.id, status: h.status, createdAt: h.createdAt })),
      })),
    };
  }

  /**
   * Render the invoice and return both the record and the bytes.
   *
   * The S3 copy is an archive, not the download route: `saveBuffer` with no
   * folder puts it under `general/`, which the bucket policy deliberately does
   * NOT expose publicly — an invoice carries the customer's name, address and
   * phone. The caller serves the buffer over the authenticated API instead.
   */
  /**
   * The invoice record — number, issue date, order link. No rendering.
   *
   * Separate from the PDF because the storefront asks for the record to decide
   * whether a Download button applies, and answering that by launching headless
   * Chromium meant simply opening an order detail page started a browser on the
   * server.
   */
  private async invoiceRecord(userId: string, orderId: string): Promise<{ order: Order; inv: Invoice }> {
    const order = await this.order.findOne({
      where: { id: orderId, userId },
      include: [User, GiftCard, Payment]
    });
    if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");

    if (order.paymentMethod !== "cod" && order.paymentStatus !== PaymentStatus.CAPTURED) {
      throw new ConflictException("CONFLICT", "Cannot generate invoice for unpaid order.");
    }

    const [inv] = await this.invoiceModel.findOrCreate({
      where: { orderId },
      defaults: { orderId, number: `INV-${order.orderNumber.replace(/[^A-Za-z0-9]/g, "")}`, issuedAt: new Date(), url: null } as any,
    });

    return { order, inv };
  }

  private async renderInvoice(userId: string, orderId: string): Promise<{ inv: Invoice; pdf: Buffer }> {
    const { order, inv } = await this.invoiceRecord(userId, orderId);

    const ships = await this.shipment.findAll({ where: { orderId } });
    const items = await this.orderItem.findAll({ where: { shipmentId: ships.map((s) => s.id) } });

    // Registration numbers print only once the business has entered them.
    const regs = await this.settingModel.findAll({ where: { key: ["business.gst", "business.fssai"] } });
    const reg = (key: string) => String(regs.find((r) => r.key === key)?.value ?? "").trim();
    const html = this.buildInvoiceHtml(order, inv.number, items, { gstin: reg("business.gst"), fssai: reg("business.fssai") });

    // Lazy-load puppeteer (ESM-only, heavy) so it is only resolved when an invoice
    // is actually generated — keeps app/context boot fast and CJS-loader friendly.
    /*
     * Rendered through the shared helper.
     *
     * This used to be its own inline puppeteer.launch — the third copy of the
     * same code — which is how a launch-flag change landed here and nowhere
     * else, and how the flags that broke invoices in the container were only
     * on this path. One implementation now; see pdf.util.ts for why the
     * sandbox flags are what they are.
     */
    const pdf = await htmlToPdf(html, "invoice");


    // Archived for the books. A storage outage must not stop the customer
    // downloading what has already been rendered.
    try {
      /*
       * Own prefix, not the default `general/`.
       *
       * An invoice carries the customer's name, phone and full delivery
       * address. It was being archived alongside product photographs, so a
       * bucket policy that makes product images public necessarily made
       * invoices public too — unguessable by UUID, but not access-controlled.
       * A separate prefix is what lets the bucket policy treat them
       * differently. Customers download invoices through the authenticated
       * endpoint, which renders them; this copy is the archive.
       */
      // Once per invoice. Every render used to write a fresh object, leaving
      // an unbounded pile of copies of a document carrying the customer's
      // name and address.
      if (!inv.url) {
        const url = await storageProvider.saveBuffer(pdf, `${inv.number}.pdf`, "invoices");
        await inv.update({ url });
      }
    } catch (e) {
      this.logger.warn(
        `Invoice ${inv.number} could not be archived to storage: ${(e as Error).message}`,
      );
    }

    return { inv, pdf };
  }

  /** The invoice record. Renders nothing — see `invoicePdf` for the bytes. */
  async invoice(userId: string, orderId: string) {
    const { inv } = await this.invoiceRecord(userId, orderId);
    // Without the archive's storage URL: the PDF is served over the
    // authenticated endpoint, and the archive copy is not a download link.
    const { url, ...record } = inv.toJSON() as any;
    return record;
  }

  /** The invoice as bytes, for streaming over the authenticated API. */
  async invoicePdf(userId: string, orderId: string): Promise<{ filename: string; pdf: Buffer }> {
    const { inv, pdf } = await this.renderInvoice(userId, orderId);
    return { filename: `${inv.number}.pdf`, pdf };
  }

  /**
   * HTML-escape a value destined for the invoice.
   *
   * `buildInvoiceHtml` escaped nothing at all, and every string on the page —
   * product names, the payment reference, and the delivery address the
   * customer types themselves — went straight into markup that a headless
   * Chromium then rendered. A `<script>` or an `<iframe src="file:///...">` in
   * an address line was executed server-side and baked into the PDF.
   */
  private readonly esc = (v: unknown): string =>
    String(v ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
    ));

  /**
   * A product image URL, or "" if it is not one we will load.
   *
   * Restricted to https and data: because this value reaches `src=`. A
   * `javascript:` or `file://` URL there is the same class of problem as the
   * unescaped text above, and `upload-resolver.util.ts` accepts a raw url
   * string without checking its scheme.
   */
  private readonly safeImg = (v: unknown): string => {
    const url = String(v ?? "").trim();
    if (!/^https:\/\//i.test(url) && !/^data:image\//i.test(url)) return "";
    return this.esc(url);
  };

  private buildInvoiceHtml(order: Order, number: string, items: OrderItem[], seller: { gstin: string; fssai: string }): string {
    const esc = this.esc;
    const safeImg = this.safeImg;
    const address = order.addressSnapshot as any || {};
    const user = order.user;

    // Stored value applied to this order. The invoice previously only accounted
    // for the gift card, so a wallet-funded order overstated "Amount Paid".
    const gcUsed = Number(order.giftCardDiscount) || 0;
    const walletUsed = Number(order.walletAmount) || 0;
    const storedValueUsed = gcUsed + walletUsed;
    const amountPaid = Number(order.payableAmount ?? Math.max(0, Number(order.total) - storedValueUsed));
    // What actually settled the order, for the "Payment:" label.
    const gatewayLabel = order.paymentMethod === PaymentMethod.COD ? "COD" : "UPI/CARD";
    const paidWith = [
      gcUsed > 0 ? "GIFT CARD" : null,
      walletUsed > 0 ? "WALLET" : null,
      amountPaid > 0 ? gatewayLabel : null,
    ].filter(Boolean).join(" + ") || gatewayLabel;

    // Original price of each reward line, read from the frozen promotion snapshot, so the
    // invoice can show "Unit Price ₹399 / Promotion Discount −₹399 / Final ₹0" for a free
    // reward (accounting-friendly) rather than a bare ₹0. Presentation only.
    const snapRewards: any[] = ((order as any).promotionSnapshot?.rewards) || ((order as any).bogoSnapshot?.rewards) || [];
    const rewardOrig: Record<string, number> = {};
    snapRewards.forEach((r) => { if (r.variantId) rewardOrig[r.variantId] = Number(r.unitPriceBefore || 0); });

    const rows = items
      .map((i) => {
        /*
         * Escaped here, at the source. Everything on this row is customer- or
         * catalogue-controlled and lands in an HTML document that a headless
         * browser then renders.
         */
        const title = esc(i.productName || "Product");
        const sku = esc(i.sku || "N/A");
        const attrs = i.variantAttributes ? esc(Object.values(i.variantAttributes).join(" • ")) : "";
        const isFree = !!(i as any).isFree;
        const freeBadge = isFree
          ? `<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; background:#dcfce7; color:#15803d; font-size:10px; font-weight:700; letter-spacing:0.5px; vertical-align:middle;">FREE REWARD</span>`
          : "";
        // Free reward: show original unit price + the promotion discount that zeroes it.
        const origUnit = isFree ? (rewardOrig[(i as any).variantId] ?? Number(i.unitPrice || i.price)) : Number(i.unitPrice || i.price);
        const unitCell = `₹${origUnit.toFixed(2)}`;
        const totalCell = isFree
          ? `<div style="color:#15803d; font-size:11px;">Promotion Discount −₹${(origUnit * i.quantity).toFixed(2)}</div><div style="font-weight:700; color:#15803d;">₹0.00</div>`
          : `₹${(Number(i.subtotal) || Number(i.unitPrice || i.price) * i.quantity).toFixed(2)}`;

        return `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid ${BRAND.border};">
            <div style="display: flex; gap: 12px; align-items: center;">
              ${safeImg(i.productImage) ? `<img src="${safeImg(i.productImage)}" style="width: 48px; height: 48px; object-fit: contain; border-radius: 8px; border: 1px solid ${BRAND.border}; background: ${BRAND.surface};" />` : ''}
              <div>
                <div style="font-weight: 600; color: ${BRAND.ink}; font-size: 14px;">${title}${freeBadge}</div>
                ${attrs ? `<div style="font-size: 12px; color: ${BRAND.muted}; margin-top: 2px;">${attrs}</div>` : ''}
                <div style="font-size: 11px; color: ${BRAND.muted}; font-family: monospace; margin-top: 4px;">SKU: ${sku}</div>
              </div>
            </div>
          </td>
          <td style="padding: 12px; border-bottom: 1px solid ${BRAND.border}; text-align: center; color: ${BRAND.muted}; font-size: 14px;">${i.quantity}</td>
          <td style="padding: 12px; border-bottom: 1px solid ${BRAND.border}; text-align: right; color: ${BRAND.muted}; font-size: 14px;">${unitCell}</td>
          <td style="padding: 12px; border-bottom: 1px solid ${BRAND.border}; text-align: right; font-weight: 600; color: ${BRAND.ink}; font-size: 14px;">${totalCell}</td>
        </tr>`;
      })
      .join("");

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${number}</title>
<style>
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: ${BRAND.ink}; margin: 0; padding: 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; padding-bottom: 24px; border-bottom: 3px solid ${BRAND.primary}; }
  .brand h1 { color: ${BRAND.primary}; margin: 0; font-size: 24px; letter-spacing: 2px; text-transform: uppercase; font-family: Georgia, 'Times New Roman', serif; }
  .brand .tagline { margin: 0 0 8px 0; color: ${BRAND.muted}; font-size: 13px; font-style: italic; }
  .brand p { margin: 0; color: ${BRAND.muted}; font-size: 13px; line-height: 1.5; }
  .invoice-meta { text-align: right; }
  .invoice-meta h2 { color: ${BRAND.primary}; margin: 0 0 8px 0; font-size: 24px; text-transform: uppercase; letter-spacing: 1px; }
  .invoice-meta p { margin: 2px 0; font-size: 13px; color: ${BRAND.muted}; }
  .info-blocks { display: flex; gap: 40px; margin-bottom: 40px; }
  .info-block { flex: 1; background: ${BRAND.surface}; padding: 20px; border-radius: 12px; border: 1px solid ${BRAND.border}; }
  .info-block h3 { margin: 0 0 12px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: ${BRAND.muted}; }
  .info-block strong { color: ${BRAND.ink}; font-size: 15px; display: block; margin-bottom: 4px; }
  .info-block p { margin: 2px 0; font-size: 13px; color: ${BRAND.muted}; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 32px; }
  th { text-align: left; padding: 12px; background: ${BRAND.surface}; color: ${BRAND.primaryDark}; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid ${BRAND.border}; }
  .summary { width: 320px; margin-left: auto; }
  .summary-row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 14px; color: ${BRAND.muted}; }
  .summary-row.total { border-top: 2px solid ${BRAND.amber}; padding-top: 12px; margin-top: 4px; font-weight: 700; font-size: 18px; color: ${BRAND.primaryDark}; }
  .footer { margin-top: 64px; padding-top: 24px; border-top: 1px solid ${BRAND.border}; text-align: center; color: ${BRAND.muted}; font-size: 12px; }
</style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <h1>${BRAND.legalName}</h1>
      <p class="tagline">${BRAND.name} &middot; ${BRAND.tagline}</p>
      <p>${BRAND.addressLine}<br>${BRAND.email} | ${BRAND.phone}</p>
      ${seller.gstin ? `<p>GSTIN: ${esc(seller.gstin)}</p>` : ""}
      ${seller.fssai ? `<p>FSSAI Lic. No: ${esc(seller.fssai)}</p>` : ""}
    </div>
    <div class="invoice-meta">
      <h2>INVOICE</h2>
      <p><strong>${number}</strong></p>
      <p>Order: ${esc(order.orderNumber)}</p>
      <p>Date: ${new Date().toLocaleDateString()}</p>
      ${order.payment?.gatewayRef ? `<p>Transaction ID: ${esc(order.payment.gatewayRef)}</p>` : ''}
    </div>
  </div>

  <div class="info-blocks">
    <div class="info-block">
      <h3>Billed To</h3>
      <strong>${esc(user?.name || address.label || "Customer")}</strong>
      <p>${esc(user?.email || "")}</p>
      <p>${esc(user?.phone || "")}</p>
    </div>
    <div class="info-block">
      <h3>Shipped To</h3>
      <strong>${esc(address.label || "Home")}</strong>
      <p>${esc(address.line1 || "")}${address.line2 ? `, ${esc(address.line2)}` : ""}</p>
      <p>${esc([address.city, address.state].filter(Boolean).join(", "))} ${esc(address.pincode || "")}</p>
      <p>${esc(address.country || "India")}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Product</th>
        <th style="text-align: center;">Qty</th>
        <th style="text-align: right;">Unit Price</th>
        <th style="text-align: right;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <div class="summary">
    <div class="summary-row"><span>Subtotal</span><span>₹${Number(order.subtotal).toFixed(2)}</span></div>
    ${Number(order.discount) > 0 ? `<div class="summary-row" style="color: #10b981;"><span>Discount</span><span>-₹${Number(order.discount).toFixed(2)}</span></div>` : ''}
    ${Number(order.loyaltyDiscount) > 0 ? `<div class="summary-row" style="color: #10b981;"><span>Loyalty Points</span><span>-₹${Number(order.loyaltyDiscount).toFixed(2)}</span></div>` : ''}
    ${Number(order.tax) > 0 ? `<div class="summary-row"><span>Tax</span><span>₹${Number(order.tax).toFixed(2)}</span></div>` : ""}
    <div class="summary-row"><span>Delivery</span><span>₹${Number(order.deliveryFee).toFixed(2)}</span></div>
    <div class="summary-row total"><span>${storedValueUsed > 0 ? 'Order Total' : 'Grand Total'}</span><span>₹${Number(order.total).toFixed(2)}</span></div>
    ${gcUsed > 0 ? `<div class="summary-row" style="color: ${BRAND.primary}; font-weight: 600; padding-top: 8px;"><span>Gift Card Used ${order.giftCard ? `(***${esc(order.giftCard.code.slice(-4))})` : ''}</span><span>-₹${gcUsed.toFixed(2)}</span></div>` : ''}
    ${walletUsed > 0 ? `<div class="summary-row" style="color: ${BRAND.primary}; font-weight: 600; padding-top: 8px;"><span>Wallet Used</span><span>-₹${walletUsed.toFixed(2)}</span></div>` : ''}
    ${storedValueUsed > 0 ? `<div class="summary-row total" style="margin-top: 8px; border-top: 1px solid ${BRAND.border}; padding-top: 8px;"><span>Amount Paid</span><span style="color: #10b981;">₹${amountPaid.toFixed(2)}</span></div>` : ''}
    <div style="margin-top: 16px; font-size: 12px; color: ${BRAND.muted}; text-align: right;">
      Payment: <strong style="text-transform: uppercase;">${esc(paidWith)}</strong> (${esc(order.paymentStatus)})
    </div>
  </div>

  <div class="footer">
    <p>Thank you for shopping with ${BRAND.name}.</p>
    <p style="margin-top: 4px;">For any queries, contact ${BRAND.email} or call ${BRAND.phone}.</p>
  </div>
</body>
</html>`;
  }

      /**
     * Ensure online payments are captured before fulfillment actions.
     * Throws ConflictException if payment not captured for non-COD orders.
     */
    async validatePaymentForFulfillment(orderId: string, actor: JwtPayload) {
        const { sub: actorId, role } = actor;
        const order = await this.order.findOne({ where: { id: orderId } });
        if (!order) throw new NotFoundException('NOT_FOUND', 'Order not found');

        if (order.paymentMethod !== PaymentMethod.COD && order.paymentStatus !== PaymentStatus.CAPTURED) {
            throw new ConflictException('CONFLICT', 'Online payment has not been captured. Fulfillment cannot proceed.');
        }
        await this.auditLogModel.create({
            actorId,
            action: 'payment_validation',
            entity: 'Order',
            entityId: orderId,
            before: { paymentStatus: order.paymentStatus },
            after: { paymentStatus: order.paymentStatus },
            notes: `Payment validation performed for role ${role}`
        } as any);
    }

  /**
   * Orchestrates post‑payment business logic after PAYMENT_CAPTURED event.
   * Assumes payment and order status have already been updated by verification flow.
   */
  /**
   * Book-keeping once an order's money is in: the coupon redemption becomes
   * final, loyalty points are earned and the invoice record exists. Each step is
   * idempotent. Runs for online captures and — from PaymentsService.confirmCod —
   * when cash on delivery is collected; COD orders used to get none of the three.
   */
  async bookPaidOrder(order: Order, t: Transaction) {
    if (order.couponCode) await this.promotions.finalizeRedemption(order.id, t);
    await this.loyaltyService.earnPoints(order.userId, order.id, order.total, t);
    await this.invoiceModel.findOrCreate({
      where: { orderId: order.id },
      defaults: { orderId: order.id, number: `INV-${order.orderNumber.replace(/[^A-Za-z0-9]/g, '')}`, issuedAt: new Date(), url: null } as any,
      transaction: t,
    });
  }

  /** Same book-keeping for a cash-on-delivery order, in its own transaction. */
  async bookCodCollection(orderId: string) {
    return this.sequelize.transaction(async (t) => {
      const order = await this.order.findByPk(orderId, { lock: t.LOCK.UPDATE, transaction: t });
      if (order) await this.bookPaidOrder(order, t);
    });
  }

  async handleSuccessfulPayment(orderId: string) {
    this.logger.log(`Handling successful payment for order ${orderId}`);
    return this.sequelize.transaction(async (t) => {
      // Row lock first: the verify call and the queued capture can both deliver
      // PAYMENT_CAPTURED for one order at the same moment, and without it the two
      // transactions deadlocked creating the invoice.
      const order = await this.order.findByPk(orderId, { lock: t.LOCK.UPDATE, transaction: t });
      if (!order) throw new NotFoundException('NOT_FOUND', 'Order not found');
      await this.bookPaidOrder(order, t);

      // A repeat capture event stops here — the order already left PAYMENT_PENDING
      // and its timeline row was written the first time.
      const stillPending = await this.shipment.count({ where: { orderId: order.id, status: OrderStatus.PAYMENT_PENDING }, transaction: t });
      if (!stillPending) return;

      // Update shipment statuses to PAYMENT_SUCCESS to move them out of PAYMENT_PENDING
      await this.shipment.update({ status: OrderStatus.PAYMENT_SUCCESS }, { where: { orderId: order.id }, transaction: t });

      // Call the central state machine to derive the parent order status based on shipments
      const OrderShipmentModel = this.sequelize.models.OrderShipment as any;
      await OrderShipmentModel.deriveAndUpdateOrderStatus(order.id, t);

      // Explicitly log the OrderStatus.PLACED event so the timeline acknowledges the order as fully placed
      await this.history.create({ 
        orderId: order.id, 
        status: OrderStatus.PLACED, 
        notes: 'Online payment successful, order placed', 
        actorId: order.userId 
      } as any, { transaction: t });

      // Additional audit log
      await this.auditLogModel.create({
        actorId: null,
        action: 'payment_captured',
        entity: 'Order',
        entityId: order.id,
        before: { paymentStatus: order.paymentStatus },
        after: { paymentStatus: order.paymentStatus },
      } as any, { transaction: t });
    });
  }

    async reassignShipment(shipmentId: string, newShopId: string, actorId: string, reason?: string, scopeShopId?: string | null) {
      return this.sequelize.transaction(async (t) => {
        // 1. Fetch shipment
        const shipment = await this.shipment.findByPk(shipmentId, { lock: t.LOCK.UPDATE, transaction: t });
        // A shop account may hand on only its own shop's shipments.
        if (!shipment || (scopeShopId && shipment.shopId !== scopeShopId)) {
          throw new NotFoundException("NOT_FOUND", "Shipment not found");
        }
        const oldShopId = shipment.shopId;

        // 2. Validate shipment status
        if (["delivered", "returned", "cancelled"].includes(shipment.status)) {
          throw new ConflictException("CONFLICT", `Cannot reassign shipment in status: ${shipment.status}`);
        }

        // 3. Validate target shop is different
        if (oldShopId === newShopId) {
          throw new ConflictException("CONFLICT", "Shipment is already assigned to this shop.");
        }

        // 4. Find order items in this shipment
        const items = await this.orderItem.findAll({ where: { shipmentId }, transaction: t });
        if (!items.length) {
          throw new NotFoundException("NOT_FOUND", "No items found in this shipment");
        }

        // 5. Validate stock in the new shop
        for (const item of items) {
          const targetInv = await this.inv.findOne({
            where: { shopId: newShopId, variantId: item.variantId },
            lock: t.LOCK.UPDATE,
            transaction: t,
          });

          if (!targetInv || targetInv.quantity < item.quantity) {
            throw new ConflictException(
              "CONFLICT",
              `Insufficient stock in target shop for variant SKU: ${item.sku || item.variantId}. Required: ${item.quantity}, Available: ${targetInv?.quantity || 0}`
            );
          }
        }

        // 6. Restore stock to old shop
        for (const item of items) {
          const oldInv = await this.inv.findOne({
            where: { shopId: oldShopId, variantId: item.variantId },
            lock: t.LOCK.UPDATE,
            transaction: t,
          });
          if (oldInv) {
            await oldInv.increment("quantity", { by: item.quantity, transaction: t });
          }
          await this.mov.create({
            shopId: oldShopId,
            variantId: item.variantId,
            type: "TRANSFER_IN",
            quantity: item.quantity,
            reason: "Shipment Reassigned (Restore)",
            referenceType: "REASSIGN",
            referenceId: shipment.id,
            createdBy: actorId,
          } as any, { transaction: t });
        }

        // 7. Deduct stock from new shop
        for (const item of items) {
          const newInv = await this.inv.findOne({
            where: { shopId: newShopId, variantId: item.variantId },
            lock: t.LOCK.UPDATE,
            transaction: t,
          });
          if (newInv) {
            await newInv.decrement("quantity", { by: item.quantity, transaction: t });
          }
          await this.mov.create({
            shopId: newShopId,
            variantId: item.variantId,
            type: "TRANSFER_OUT",
            quantity: item.quantity,
            reason: "Shipment Reassigned (Reserve)",
            referenceType: "REASSIGN",
            referenceId: shipment.id,
            createdBy: actorId,
          } as any, { transaction: t });
        }

        // 8. Update database references
        // Update shipment
        await shipment.update({ shopId: newShopId }, { transaction: t });
        // Update order items
        await this.orderItem.update({ shopId: newShopId }, { where: { shipmentId }, transaction: t });

        // Update routing decisions
        const variantIds = items.map((it) => it.variantId);
        if (variantIds.length > 0) {
          await this.routing.update(
            { chosenShopId: newShopId, reason: "Manual override by admin" },
            { where: { orderId: shipment.orderId, variantId: { [Op.in]: variantIds } }, transaction: t }
          );
        }

        // 9. Create Audit Log entry
        await this.auditLogModel.create({
          actorId,
          action: "reassign_shipment",
          entity: "OrderShipment",
          entityId: shipmentId,
          before: {
            shipmentId,
            orderId: shipment.orderId,
            shopId: oldShopId,
          },
          after: {
            shipmentId,
            orderId: shipment.orderId,
            shopId: newShopId,
            reason: reason || "Manual override by admin",
          },
        } as any, { transaction: t });

        return { reassigned: true };
      });
    }

    async releasePaymentTimeoutOrder(orderId: string) {
      return this.sequelize.transaction(async (t) => {
        const order = await this.order.findOne({
          where: { id: orderId, status: OrderStatus.PAYMENT_PENDING },
          lock: t.LOCK.UPDATE,
          transaction: t,
        });
        if (!order) return; // Order is already paid or cancelled

        const shipments = await this.shipment.findAll({
          where: { orderId, status: OrderStatus.PAYMENT_PENDING },
          lock: t.LOCK.UPDATE,
          transaction: t,
        });

        // actorId null: "system" is not a UUID and used to fail the whole transaction.
        await this.executeFulfillmentCancellation(t, order, shipments, null, "Payment hold timeout expired");
        await order.update({ status: OrderStatus.FAILED, paymentStatus: PaymentStatus.FAILED }, { transaction: t });
      });
    }
}

