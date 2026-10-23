import { Op, QueryTypes } from "sequelize";
import { Body, Controller, Get, Headers, HttpCode, Module, Param, Post, Query, forwardRef, Inject } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { LIMITS } from "@/common/security/throttle";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { Cart, CartItem, IdempotencyKey, Invoice, Order, OrderItem, OrderShipment, OrderStatusHistory, Product, ProductMedia, ProductVariant, RoutingDecision, Setting, ShopInventory, StockMovement, User, Shop, AuditLog, CouponRedemption, DeliveryAssignment, DeliveryPartner, Payment, PaymentRefund, EarningWallet, GiftCard, Return, PromotionRedemption } from "@/models";
import { OrdersService } from "./orders.service";
import { PricingService } from "./pricing.service";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { shopScope, assertPlatformScope } from "@/common/utils/permission.util";
import { Role } from "@/common/enums/role.enum";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate, findOr404 } from "@/common/utils/crud.util";
import { OrderStatus, PaymentMethod } from "@/common/enums/order-status.enum";
import { ForbiddenException, NotFoundException, ConflictException } from "@/common/errors/http";
import { DeliveryEngineModule } from "@/modules/delivery-engine/delivery-engine.module";
import { PromotionsModule } from "@/modules/promotions/promotions.module";
import { WalletModule } from "@/modules/wallet/wallet.module";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { PaymentsModule } from "@/modules/payments/payments.module";
import { NotificationsService } from "@/modules/notifications/notifications.service";
import { PlaceOrderDto, ReassignDto, OrderLookupDto, OrderPreviewDto, ReasonDto, RoutingDecisionsQueryDto } from "@/common/dto/common.dto";
import { Public } from "@/common/decorators/public.decorator";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { pickPartner, candidateWhere } from "@/common/utils/partner-dispatch.util";



import { PaymentsService } from "@/modules/payments/payments.service";
import { PolicyResolutionService } from "@/modules/returns/policy-resolution.service";
import { PAYMENT_CUSTOMER_ATTRS, GIFT_CARD_HOLDER_ATTRS } from "@/common/security/public-attributes";

/**
 * Columns the order views actually read.
 *
 * Without an `attributes` list Sequelize selects every column at every level,
 * so an order list carried each product's full `description` TEXT and
 * `specifications` JSONB — for a card that shows a title, an image and a
 * quantity. The two media levels are deliberate, not duplication:
 * `resolveOrderImage` prefers variant art and falls back to product art.
 */
const ORDER_LINE_INCLUDE = (mediaModel: any, productModel: any, variantModel: any) => ({
  model: variantModel,
  attributes: ["id", "productId", "defaultPrice", "mrp", "sku", "attributes"],
  include: [
    { model: mediaModel, attributes: ["id", "url", "sortOrder", "variantId", "productId"] },
    {
      model: productModel,
      attributes: ["id", "title", "subtitle", "categoryId", "brandId"],
      include: [{ model: mediaModel, attributes: ["id", "url", "sortOrder", "productId"] }],
    },
  ],
});

@ApiTags("Orders")
@ApiBearerAuth()
@Controller("orders")
export class OrdersController {
  constructor(
    private orders: OrdersService,
    private pricing: PricingService,
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
    @InjectModel(Order) private order: typeof Order,
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(OrderStatusHistory) private hist: typeof OrderStatusHistory,
    @InjectModel(RoutingDecision) private routing: typeof RoutingDecision,
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(OrderItem) private orderItem: typeof OrderItem,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    @InjectModel(DeliveryAssignment) private assignModel: typeof DeliveryAssignment,
    @InjectModel(DeliveryPartner) private partnerModel: typeof DeliveryPartner,
    @InjectModel(Setting) private settingModel: typeof Setting,
    @InjectModel(EarningWallet) private walletModel: typeof EarningWallet,
    @InjectModel(Return) private returnReq: typeof Return,
    @Inject(forwardRef(() => NotificationsService))
    private notifications: NotificationsService,
    private policyResolutionService: PolicyResolutionService,
  ) {}

  /**
   * A shop manager may only act on shipments belonging to their own shop.
   * Admins are unrestricted. Returns the shipment so callers can reuse it.
   */
  private async assertShipmentScope(u: JwtPayload, shipmentId: string): Promise<OrderShipment> {
    const shipment = await this.ship.findByPk(shipmentId);
    if (!shipment) throw new NotFoundException("NOT_FOUND", "Shipment not found");
    if (u.role === Role.SHOP_MANAGER && shipment.shopId !== u.shopId) throw new ForbiddenException("AUTH_FORBIDDEN");
    return shipment;
  }

  /** Notify the order's customer about a fulfillment status change. */
  private async notifyCustomer(shipment: OrderShipment, title: string, body: string) {
    const order = await this.order.findByPk(shipment.orderId);
    // The customer route, not the dashboard one — this is the only place these
    // particular notifications go.
    if (order) await this.notifications.notify(order.userId, title, body, "all", `/my-orders/${order.id}`);
  }

  /**
   * Attach `returnedQuantity` / `returnableQuantity` to every order item across
   * the given (plain-JSON) orders, so the storefront can offer partial returns
   * and cap the quantity picker at what's still eligible. `returnable = purchased
   * − Σ(non-rejected return quantities)`; a legacy return with a null quantity
   * counts as the whole line.
   */
  private async attachReturnQuantities(orders: any[]): Promise<void> {
    const itemIds: string[] = [];
    for (const o of orders || []) for (const s of o.shipments || []) for (const it of s.items || []) itemIds.push(it.id);
    if (!itemIds.length) return;
    const returns = await this.returnReq.findAll({
      where: { orderItemId: { [Op.in]: itemIds }, status: { [Op.ne]: 'rejected' } },
      attributes: ['orderItemId', 'quantity'],
      raw: true,
    });
    const byItem = new Map<string, any[]>();
    for (const r of returns) {
      const arr = byItem.get(r.orderItemId) || [];
      arr.push(r);
      byItem.set(r.orderItemId, arr);
    }
    for (const o of orders || []) for (const s of o.shipments || []) for (const it of s.items || []) {
      const purchased = Number(it.quantity) || 0;
      const rs = byItem.get(it.id) || [];
      const returned = rs.reduce((sum, r) => sum + (r.quantity == null ? purchased : Number(r.quantity)), 0);
      it.returnedQuantity = returned;
      it.returnableQuantity = Math.max(0, purchased - returned);
    }
  }

  @Post() create(@CurrentUser() u: JwtPayload, @Body() body: PlaceOrderDto, @Headers("idempotency-key") idemKey?: string) {
    return this.orders.create(u.sub, body, idemKey);
  }

  /**
   * Pure pricing: subtotal, parcel weight and destination state in, the rate
   * card's answer out. It reads nothing about the caller, so it is public —
   * a signed-out visitor's cart shows a real delivery charge, and this leaks
   * nothing beyond the published card.
   */
  @Public()
  @Post("preview")
  preview(@Body() body: OrderPreviewDto) {
    return this.pricing.compute(
      body.subtotal,
      body.discount || 0,
      body.express || false,
      body.freeDelivery || false,
      body.giftCardBalance || 0,
      body.loyaltyDiscount || 0,
      { parcelG: body.parcelG, state: body.state }
    );
  }

  @Get("me")
  async my(
    @CurrentUser() u: JwtPayload,
    @Query() opts: PageOptionsDto,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
  ) {
    const where: any = { userId: u.sub };

    if (status && status !== "all") {
      if (status === "placed") {
        where.status = { [Op.notIn]: ["delivered", "cancelled", "returned"] };
      } else {
        where.status = status;
      }
    }

    if (from || to) {
      where.createdAt = {};
      if (from) {
        where.createdAt[Op.gte] = new Date(from);
      }
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        where.createdAt[Op.lte] = toDate;
      }
    }

    if (opts.q) {
      where.orderNumber = { [Op.iLike]: `%${opts.q}%` };
    }

    const result: any = await paginate(this.order, opts, where, [{
      model: this.ship,
      include: [{
        model: OrderItem,
        include: [ORDER_LINE_INCLUDE(ProductMedia, Product, ProductVariant)],
      }]
    }]);
    // Serialize to plain objects so the return-quantity fields survive JSON
    // (a Sequelize instance's toJSON would otherwise drop the extra props), then
    // annotate each item with how much of it is still returnable.
    result.items = (result.items || []).map((o: any) => (o?.toJSON ? o.toJSON() : o));
    await this.attachReturnQuantities(result.items);
    return result;
  }

  /* ──────────────── Guest order tracking — unauthenticated ────────────────
   * A customer who checked out with an OTP may never sign back in, so these
   * two routes let them see an order from a cold browser. They return a
   * reduced projection (no address, no user), answer every failure the same
   * way, and are throttled: the order-number space is guessable, so this is
   * an enumeration surface and the limits are part of the design.
   */

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("lookup")
  @HttpCode(200)
  lookup(@Body() dto: OrderLookupDto) {
    return this.orders.lookupByNumber(dto.orderNumber, dto.contact);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("lookup/:token")
  lookupByToken(@Param("token") token: string) {
    return this.orders.lookupByToken(token);
  }

  @Get("me/:id") async myDetail(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    // The customer's own payment and gift card, minus internals (idempotency
    // keys, gateway order ids, staff notes) the full rows used to carry.
    const order = await this.order.findOne({
      where: { id, userId: u.sub },
      include: [{ model: GiftCard, attributes: GIFT_CARD_HOLDER_ATTRS }, { model: Payment, attributes: PAYMENT_CUSTOMER_ATTRS }],
    });
    if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");
    
    // JIT Payment Reconciliation
    if (order.paymentMethod !== PaymentMethod.COD && order.paymentStatus === "pending") {
      await this.paymentsService.jitReconcileOrder(order.id);
      await order.reload(); // Refresh the order state after potential update
    }

    let shipments = await this.ship.findAll({
      where: { orderId: id },
      include: [{
        model: OrderItem,
        include: [ORDER_LINE_INCLUDE(ProductMedia, Product, ProductVariant)],
      }]
    });
    
    // Return requests for THIS order's items. It loaded every return the
    // customer had ever made, on every order page view.
    const orderItemIds = shipments.flatMap((s: any) => (s.items ?? []).map((i: any) => i.id));
    const returns = orderItemIds.length
      ? await this.returnReq.findAll({ where: { userId: u.sub, orderItemId: orderItemIds }, raw: true })
      : [];
    
    // Bulk resolve policies to avoid N+1 queries
    const itemsToResolve: { productId: string; categoryId?: string }[] = [];
    shipments.forEach(s => {
      s.items?.forEach(item => {
        if (item.variant?.product) {
          itemsToResolve.push({ productId: item.variant.productId, categoryId: item.variant.product.categoryId || undefined });
        }
      });
    });

    const resolvedPolicies = await this.policyResolutionService.resolvePoliciesBulk(itemsToResolve);

    // Attach return info and resolved policies to each order item
    const shipmentsJson = shipments.map(s => {
      const sJson = s.toJSON() as any;
      if (sJson.items) {
        sJson.items = sJson.items.map((item: any) => {
          // An item can now have several partial returns; keep the first as
          // `returnRequest` for back-compat and compute how much is still eligible.
          const itemReturns = returns.filter(r => r.orderItemId === item.id);
          if (itemReturns.length) {
            item.returnRequest = itemReturns[0];
          }
          const purchased = Number(item.quantity) || 0;
          const returned = itemReturns
            .filter(r => r.status !== 'rejected')
            .reduce((sum, r) => sum + ((r as any).quantity == null ? purchased : Number((r as any).quantity)), 0);
          item.returnedQuantity = returned;
          item.returnableQuantity = Math.max(0, purchased - returned);

          if (item.variant?.productId) {
            const policy = resolvedPolicies[item.variant.productId];
            if (policy) {
              item.canReturn = policy.isReturnable;
              item.canExchange = policy.isReplaceable;
              item.policy = policy;
            }
          }

          return item;
        });
      }
      return sJson;
    });

    const isCancelled = order.status === OrderStatus.CANCELLED || order.status === OrderStatus.CANCEL_REQUESTED;
    const hasShippedOrLater = shipments.some(s => 
      [OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED].includes(s.status)
    );
    const hasPacked = shipments.some(s => s.status === OrderStatus.PACKED);

    const canCancel = !isCancelled && !hasShippedOrLater && !hasPacked;
    const canRequestCancel = !isCancelled && !hasShippedOrLater && hasPacked;
    const canReturn = order.status === OrderStatus.DELIVERED;
    const canDownloadInvoice = (order.paymentMethod === "cod" || order.paymentStatus === "captured" as any) && order.status !== OrderStatus.CANCELLED;
    const canReorder = true;
    const canTrack = shipments.some(s => s.status === OrderStatus.OUT_FOR_DELIVERY || s.status === OrderStatus.SHIPPED);
    const canReview = shipments.some(s => s.status === OrderStatus.DELIVERED);

    const amountPaid = Math.max(0, Number(order.total) - Number(order.giftCardDiscount));
    
    return {
      order: {
        ...order.toJSON(),
        canCancel,
        canRequestCancel,
        canReturn,
        canDownloadInvoice,
        canReorder,
        canTrack,
        canReview
      },
      amountPaid,
      giftCardDiscount: order.giftCardDiscount,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      shipments: shipmentsJson,
      history: await this.hist.findAll({ where: { orderId: id }, order: [["createdAt", "ASC"]] }),
    };
  }

  @Post("me/:id/cancel") cancel(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() body?: ReasonDto) {
    return this.orders.cancel(u.sub, id, body?.reason);
  }

  @RequirePermissions('orders.cancel')
  @Post("admin/:id/cancel") adminCancel(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() body?: ReasonDto) {
    return this.orders.adminCancel(id, body?.reason, u.sub, shopScope(u));
  }

  @RequirePermissions('orders.cancel')
  @Post("manager/shipments/:id/cancel") managerCancel(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() body?: ReasonDto) {
    return this.orders.managerCancel(u, id, body?.reason);
  }

  @RequirePermissions('orders.cancel')
  @Post("manager/shipments/:id/approve-cancel") managerApprove(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() body?: ReasonDto) {
    return this.orders.approveCancellationRequest(u, id, body?.reason);
  }

  @RequirePermissions('orders.cancel')
  @Post("manager/shipments/:id/reject-cancel") managerReject(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() body?: ReasonDto) {
    return this.orders.rejectCancellationRequest(u, id, body?.reason);
  }

  @Post("me/:id/reorder") reorder(@CurrentUser() u: JwtPayload, @Param("id") id: string) { return this.orders.reorder(u.sub, id); }
  @Throttle(LIMITS.export)
  @Get("me/:id/invoice.pdf") invoice(@CurrentUser() u: JwtPayload, @Param("id") id: string) { return this.orders.invoice(u.sub, id); }

  @RequirePermissions('orders.view')
  @Get("shops/:shopId") async shopQueue(@CurrentUser() u: JwtPayload, @Param("shopId") shopId: string, @Query() opts: PageOptionsDto) {
    if (u.role === Role.SHOP_MANAGER) {
      if (u.shopId !== shopId) throw new ForbiddenException("AUTH_FORBIDDEN");
    }
    const where: any = {};
    if (shopId !== "all") {
      where.shopId = shopId;
    }
    if (opts.status) {
      if (opts.status === "placed") {
        where.status = { [Op.in]: ["placed", "payment_success"] };
      } else {
        where.status = opts.status;
      }
    }
    return paginate(this.ship, opts, where, [
      // Eager-load the parent order (for customer name, total, payment method)
      { model: Order, as: "order" },
      // Eager-load line items with variant → product so the UI shows product names
      {
        model: OrderItem,
        as: "items",
        include: [{ ...ORDER_LINE_INCLUDE(ProductMedia, Product, ProductVariant), as: "variant" }],
      },
      // Eager-load the per-shipment history trail with actor names
      {
        model: OrderStatusHistory,
        as: "history",
        include: [{ model: User, as: "actor", attributes: ["id", "name", "email", "avatarUrl"] }],
      },
    ]);
  }

  /**
   * True when the shipment is ALREADY in the target status, i.e. this call is a
   * no-op repeat (double-click, retried request). Re-running a transition used to
   * append another history row, another audit log and another customer
   * notification — which is how a status ended up twice in the trail even after
   * the double-write fix. A no-op must leave the audit trail untouched.
   */
  private isNoOpTransition(shipment: OrderShipment, target: string) {
    return shipment.status === target;
  }

  /**
   * The statuses each shop action may start from. Without this any action ran
   * from any state — "deliver" straight from "placed", "pack" on a cancelled
   * shipment — and the timeline, stock and earnings went with it.
   */
  private static readonly ALLOWED_FROM: Record<string, OrderStatus[]> = {
    accept: [OrderStatus.PLACED, OrderStatus.PAYMENT_SUCCESS, OrderStatus.ROUTED],
    pack: [OrderStatus.CONFIRMED],
    handover: [OrderStatus.PACKED],
    // FAILED: the shop's own van re-attempts after a failed partner delivery
    outForDelivery: [OrderStatus.SHIPPED, OrderStatus.HANDED_OVER, OrderStatus.FAILED],
    deliver: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.SHIPPED, OrderStatus.HANDED_OVER],
    cannotFulfill: [OrderStatus.PLACED, OrderStatus.PAYMENT_SUCCESS, OrderStatus.ROUTED, OrderStatus.CONFIRMED],
  };

  private assertTransition(shipment: OrderShipment, action: string) {
    const allowed = OrdersController.ALLOWED_FROM[action] || [];
    if (!allowed.includes(shipment.status as OrderStatus)) {
      throw new ConflictException("CONFLICT", `A shipment that is "${shipment.status}" cannot be moved by "${action}".`);
    }
  }

  @RequirePermissions('fulfillment.view')
  @Post("shipments/:id/accept") async accept(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const shipment = await this.assertShipmentScope(u, id);
    // Idempotent: a repeated call must not append a duplicate audit event.
    if (this.isNoOpTransition(shipment, OrderStatus.CONFIRMED)) {
      return { alreadyApplied: true, status: shipment.status };
    }
    this.assertTransition(shipment, "accept");
await this.orders.validatePaymentForFulfillment(shipment.orderId, u);
    const oldStatus = shipment.status;
    await this.ship.update({ status: OrderStatus.CONFIRMED }, { where: { id } });
    // ONE history row carrying BOTH ids: the shipment view queries by shipmentId,
    // the customer order view by orderId, and the admin trail unions the two — so a
    // single row satisfies all three and the trail can no longer show it twice.
    await this.hist.create({ orderId: shipment.orderId, shipmentId: id, status: OrderStatus.CONFIRMED, notes: `Shipment ${shipment.shipmentNumber} accepted by shop`, actorId: u.sub } as any);
    await this.auditLogModel.create({
      actorId: u.sub,
      action: "accept",
      entity: "OrderShipment",
      entityId: id,
      before: { status: oldStatus },
      after: { status: OrderStatus.CONFIRMED }
    } as any);
    await OrderShipment.deriveAndUpdateOrderStatus(shipment.orderId);
    await this.notifyCustomer(shipment, "Order confirmed", "The shop has accepted your order and will pack it shortly.");
    
    this.orders.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.SHIPMENT_ACCEPTED,
      variables: { orderId: shipment.orderId, shipmentId: id, shopId: shipment.shopId }
    });

    return { accepted: true };
  }
  @RequirePermissions('fulfillment.view')
  @Post("shipments/:id/pack") async pack(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const shipment = await this.assertShipmentScope(u, id);
    // Idempotent: a repeated call must not append a duplicate audit event.
    if (this.isNoOpTransition(shipment, OrderStatus.PACKED)) {
      return { alreadyApplied: true, status: shipment.status };
    }
    this.assertTransition(shipment, "pack");
await this.orders.validatePaymentForFulfillment(shipment.orderId, u);
    const oldStatus = shipment.status;
    await this.ship.update({ status: OrderStatus.PACKED }, { where: { id } });
    await this.hist.create({ orderId: shipment.orderId, shipmentId: id, status: OrderStatus.PACKED, notes: `Shipment ${shipment.shipmentNumber} packed`, actorId: u.sub } as any);
    await this.auditLogModel.create({
      actorId: u.sub,
      action: "pack",
      entity: "OrderShipment",
      entityId: id,
      before: { status: oldStatus },
      after: { status: OrderStatus.PACKED }
    } as any);
    await OrderShipment.deriveAndUpdateOrderStatus(shipment.orderId);
    await this.notifyCustomer(shipment, "Order packed 📦", "Your order has been packed and is awaiting pickup.");

    this.orders.eventEmitter.emit("order.packed", {
      orderId: shipment.orderId,
      shipmentId: id
    });

    await this.notifications.notifyShopManagers([shipment.shopId], "Shipment packed", `Shipment ${shipment.shipmentNumber} is packed and ready.`);

    return { packed: true };
  }
  /**
   * Whether the shop dispatches with its own riders.
   *
   * Off by default: orders ship by courier, so handover means "given to the
   * courier", not "given to a partner". An absent setting reads as off, so an
   * un-migrated database behaves the same way.
   */
  private async useDeliveryPartners(): Promise<boolean> {
    const row = await this.settingModel.findOne({ where: { key: "fulfillment.useDeliveryPartners" } });
    const v = row?.value as unknown;
    return v === true || v === "true";
  }

  @RequirePermissions('fulfillment.ship')
  @Post("shipments/:id/handover") async handover(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const shipment = await this.assertShipmentScope(u, id);
    // Idempotent: a repeated call must not append a duplicate audit event.
    if (this.isNoOpTransition(shipment, OrderStatus.SHIPPED)) {
      return { alreadyApplied: true, status: shipment.status };
    }
    this.assertTransition(shipment, "handover");
await this.orders.validatePaymentForFulfillment(shipment.orderId, u);
    const oldStatus = shipment.status;

    // Mark shipment as handed over and record dispatch time
    await this.ship.update({ status: OrderStatus.SHIPPED, dispatchedAt: new Date() }, { where: { id } });

    await this.hist.create({ orderId: shipment.orderId, shipmentId: id, status: OrderStatus.SHIPPED, notes: `Shipment ${shipment.shipmentNumber} handed over for dispatch`, actorId: u.sub } as any);

    await this.auditLogModel.create({
      actorId: u.sub,
      action: "handover",
      entity: "OrderShipment",
      entityId: id,
      before: { status: oldStatus },
      after: { status: OrderStatus.SHIPPED }
    } as any);

    // ── Offer the shipment to a delivery partner ─────────────────────────────
    // Only when the shop runs its own riders. Parcels handed to a courier —
    // India Post or the private courier — have no partner to assign, and
    // offering the job anyway created assignments nobody would ever accept,
    // plus "no partner online" warnings for a shipment that was never going to
    // have one.
    //
    // Gated rather than removed: the ranking and re-offer logic below is
    // correct and worth keeping if own-fleet delivery ever returns.
    if (await this.useDeliveryPartners()) {
    // Ranked by distance to the drop point, then by who has taken the fewest
    // jobs today, then rating — see pickPartner().
    const onlinePartners = await this.partnerModel.findAll({ where: candidateWhere() });
    const partner = pickPartner(onlinePartners as any, {
      dropLat: shipment.dropLat as any,
      dropLng: shipment.dropLng as any,
    });

    if (partner) {
      await this.assignModel.create({
        shipmentId: id,
        partnerId: partner.id,
        status: "offered",
        offeredAt: new Date(),
      } as any);
      // Link partner on the shipment row for fast lookup
      await this.ship.update({ deliveryPartnerId: partner.id }, { where: { id } });
      if (partner.userId) {
        await this.notifications.notify(
          partner.userId,
          "New delivery job 🛵",
          `A new delivery assignment is available for pickup. Accept it before it expires.`,
        );
      }

      this.orders.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.SHIPMENT_ASSIGNED,
        variables: { shipmentId: id, partnerId: partner.id }
      });
      await this.notifications.notifyShopManagers([shipment.shopId], "Delivery assigned", `Delivery partner assigned for shipment ${shipment.shipmentNumber}.`);
    } else {
      // Nobody online. The shipment is still handed over — the goods have
      // physically left the shelf — but it now has no courier, and that has to
      // be visible. Silently doing nothing here is what left shipments sitting
      // in SHIPPED with no partner and nobody aware of it.
      await this.ship.update({ deliveryPartnerId: null }, { where: { id } });
      this.orders.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.SHIPMENT_UNASSIGNED,
        variables: { shipmentId: id, shipmentNumber: shipment.shipmentNumber },
      });
      await this.notifications.notifyShopManagers(
        [shipment.shopId],
        "No delivery partner available ⚠️",
        `Shipment ${shipment.shipmentNumber} was handed over but no partner is online. Assign one manually.`,
      );
    }
    }

    await OrderShipment.deriveAndUpdateOrderStatus(shipment.orderId);
    await this.notifyCustomer(shipment, "Order shipped 🚚", "Your order has been handed over for delivery.");
    
    this.orders.eventEmitter.emit("order.shipped", {
      orderId: shipment.orderId,
      shipmentId: id
    });
    
    await this.notifications.notifyShopManagers([shipment.shopId], "Shipment out", `Shipment ${shipment.shipmentNumber} has been shipped.`);

    return { shipped: true };
  }
  @RequirePermissions('fulfillment.view')
  @Post("shipments/:id/cannot-fulfill") async noFulfill(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const shipment = await this.assertShipmentScope(u, id);
    this.assertTransition(shipment, "cannotFulfill");
    const oldStatus = shipment.status;
    // Through the normal cancellation path so the units go back on the shelf (and
    // the customer is refunded if this was the last open shipment). Flipping the
    // status alone left the stock decremented for good.
    await this.orders.managerCancel(u, id, "Shop cannot fulfil this shipment");
    // Record the actor and timestamp for the Cannot Fulfill action in the audit trail
    await this.hist.create({ orderId: shipment.orderId, shipmentId: id, status: "cannot_fulfill", notes: "Shop cannot fulfill", actorId: u.sub } as any);
    await this.auditLogModel.create({
      actorId: u.sub,
      action: "cannot_fulfill",
      entity: "OrderShipment",
      entityId: id,
      before: { status: oldStatus },
      after: { status: OrderStatus.CANCELLED }
    } as any);
    await OrderShipment.deriveAndUpdateOrderStatus(shipment.orderId);
    // Notify the customer that their shipment is being re-routed
    await this.notifyCustomer(shipment, "Order update", "One of your items could not be fulfilled by the assigned shop and is being re-routed.");
    return { rerouted: true };
  }

  @RequirePermissions('fulfillment.view')
  @Post("shipments/:id/out-for-delivery") async markOutForDelivery(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const shipment = await this.assertShipmentScope(u, id);
    // Idempotent: a repeated call must not append a duplicate audit event.
    if (this.isNoOpTransition(shipment, OrderStatus.OUT_FOR_DELIVERY)) {
      return { alreadyApplied: true, status: shipment.status };
    }
    this.assertTransition(shipment, "outForDelivery");
await this.orders.validatePaymentForFulfillment(shipment.orderId, u);
    const oldStatus = shipment.status;
    await this.ship.update({ status: OrderStatus.OUT_FOR_DELIVERY }, { where: { id } });
    await this.hist.create({ orderId: shipment.orderId, shipmentId: id, status: OrderStatus.OUT_FOR_DELIVERY, notes: `Shipment ${shipment.shipmentNumber} marked out for delivery`, actorId: u.sub } as any);
    await this.auditLogModel.create({
      actorId: u.sub,
      action: "out_for_delivery",
      entity: "OrderShipment",
      entityId: id,
      before: { status: oldStatus },
      after: { status: OrderStatus.OUT_FOR_DELIVERY }
    } as any);
    await OrderShipment.deriveAndUpdateOrderStatus(shipment.orderId);
    await this.notifyCustomer(shipment, "Out for delivery 🛵", "Your order is on its way!");
    return { ok: true };
  }

  @RequirePermissions('fulfillment.view')
  @Post("shipments/:id/deliver") async markDelivered(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const shipment = await this.assertShipmentScope(u, id);
    if (shipment.status === OrderStatus.DELIVERED) {
      return { ok: true };
    }
    this.assertTransition(shipment, "deliver");
    const oldStatus = shipment.status;
    await this.ship.update({ status: OrderStatus.DELIVERED, deliveredAt: new Date() }, { where: { id } });
    await this.hist.create({ orderId: shipment.orderId, shipmentId: id, status: OrderStatus.DELIVERED, notes: `Shipment ${shipment.shipmentNumber} marked delivered`, actorId: u.sub } as any);
    
    await this.auditLogModel.create({
      actorId: u.sub,
      action: "deliver",
      entity: "OrderShipment",
      entityId: id,
      before: { status: oldStatus },
      after: { status: OrderStatus.DELIVERED }
    } as any);
    
    await OrderShipment.deriveAndUpdateOrderStatus(shipment.orderId);

    this.orders.eventEmitter.emit("order.delivered", {
      orderId: shipment.orderId,
      shipmentId: id
    });

    // Shop Wallet Pending Earnings Update (idempotent per shipment — see EarningWallet.creditOnDelivery)
    const items = await this.orderItem.findAll({ where: { shipmentId: id } });
    const totalCost = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);

    await this.walletModel.creditOnDelivery({
      shopId: shipment.shopId,
      orderId: shipment.orderId,
      amount: totalCost,
      referenceId: shipment.shipmentNumber,
    });

    await this.notifyCustomer(shipment, "Delivered ✅", "Your order has been delivered.");
    
    this.orders.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.SHIPMENT_DELIVERED,
      variables: { orderId: shipment.orderId, shipmentId: id, shopId: shipment.shopId }
    });
    await this.notifications.notifyShopManagers([shipment.shopId], "Shipment delivered", `Shipment ${shipment.shipmentNumber} was successfully delivered.`);

    return { ok: true };
  }

  @RequirePermissions('orders.view')
  @Get("admin")
  all(
    @CurrentUser() u: JwtPayload,
    @Query() opts: PageOptionsDto,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("userId") userId?: string,
  ) {
    const where: any = {};

    if (userId) {
      where.userId = userId;
    }

    let activeStatus = status || opts.status;
    if (activeStatus === "out_for_delivery") {
      activeStatus = "out";
    }

    if (activeStatus && activeStatus !== "all") {
      if (activeStatus === "placed") {
        where.status = { [Op.in]: ["placed", "payment_success"] };
      } else {
        where.status = activeStatus;
      }
    }

    if (from || to) {
      where.createdAt = {};
      if (from) {
        where.createdAt[Op.gte] = new Date(from);
      }
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        where.createdAt[Op.lte] = toDate;
      }
    }

    if (opts.q) {
      where[Op.or] = [
        { orderNumber: { [Op.iLike]: `%${opts.q}%` } },
        { "$user.name$": { [Op.iLike]: `%${opts.q}%` } },
      ];
    }

    const include: any[] = [
      { model: User, as: "user", attributes: ["id", "name", "email", "avatarUrl"] },
      { model: Payment, as: "payment" }
    ];

    if (u.role === Role.SHOP_MANAGER) {
      if (!u.shopId) {
        throw new ForbiddenException("AUTH_FORBIDDEN", "Shop Manager must be assigned to a shop");
      }
      include.push({
        model: this.ship,
        as: "shipments",
        where: { shopId: u.shopId },
        required: true,
      });
    }

    return paginate(this.order, opts, where, include);
  }


  @RequirePermissions('orders.view')
  @Get("admin/routing/kpis")
  async routingKpis(@CurrentUser() u: JwtPayload) {
    // Platform-wide counts (every shop's routing decisions): not for shop accounts.
    assertPlatformScope(u);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const seq = this.routing.sequelize!;

    const [itemsRoutedToday, autoReRoutesToday, totalDecisions, avgRow, shopRow] = await Promise.all([
      this.routing.count({ where: { createdAt: { [Op.gte]: startOfDay } } }),
      this.hist.count({ where: { status: "cannot_fulfill", createdAt: { [Op.gte]: startOfDay } } }),
      this.routing.count(),
      // Real average routing distance for today's decisions (₀ when none yet).
      seq.query<{ avg: number }>(
        `SELECT COALESCE(AVG("distanceKm"), 0)::float8 AS avg FROM routing_decisions WHERE "createdAt" >= :d`,
        { type: QueryTypes.SELECT, replacements: { d: startOfDay } },
      ),
      seq.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM shops WHERE "isActive" = true AND "deletedAt" IS NULL`,
        { type: QueryTypes.SELECT },
      ),
    ]);

    return {
      itemsRoutedToday,
      autoReRoutesToday,
      totalDecisions,
      avgDistanceKm: Number((avgRow[0]?.avg ?? 0).toFixed(2)),
      activeShops: shopRow[0]?.c ?? 0,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Global, filterable, sortable, paginated routing-decision log. Joins the real
   * tables so each row carries the order, item, chosen shop, live stock, the matching
   * shipment's status + ETA, and the assigned delivery partner — all from the DB.
   */
  @RequirePermissions('orders.view')
  @Get("admin/routing/decisions")
  async routingDecisions(@CurrentUser() u: JwtPayload, @Query() q: RoutingDecisionsQueryDto) {
    const seq = this.routing.sequelize!;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const sortCol = q.sort === "distance" ? `rd."distanceKm"` : `rd."createdAt"`;
    const dir = String(q.dir).toLowerCase() === "asc" ? "ASC" : "DESC";

    const cond: string[] = [];
    const repl: Record<string, any> = {};
    // Shop managers only ever see their own shop's routing.
    if (u.role === Role.SHOP_MANAGER) { cond.push(`rd."chosenShopId" = :scopeShop`); repl.scopeShop = u.shopId; }
    if (q.q) { cond.push(`(o."orderNumber" ILIKE :q OR p.title ILIKE :q)`); repl.q = `%${q.q}%`; }
    if (q.shopId) { cond.push(`rd."chosenShopId" = :shopId`); repl.shopId = q.shopId; }
    if (q.zone) { cond.push(`rd.zone = :zone`); repl.zone = q.zone; }
    if (q.status) { cond.push(`sh.status = :status`); repl.status = q.status; }
    if (q.partnerId) { cond.push(`sh."deliveryPartnerId" = :partnerId`); repl.partnerId = q.partnerId; }
    if (q.dateFrom) { cond.push(`rd."createdAt" >= :df`); repl.df = new Date(q.dateFrom); }
    if (q.dateTo) { const t = new Date(q.dateTo); t.setHours(23, 59, 59, 999); cond.push(`rd."createdAt" <= :dt`); repl.dt = t; }
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";

    const base = `
      FROM routing_decisions rd
      JOIN orders o ON o.id = rd."orderId"
      LEFT JOIN users cu ON cu.id = o."userId"
      LEFT JOIN product_variants v ON v.id = rd."variantId"
      LEFT JOIN products p ON p.id = v."productId"
      LEFT JOIN shops s ON s.id = rd."chosenShopId"
      LEFT JOIN order_shipments sh ON sh."orderId" = rd."orderId" AND sh."shopId" = rd."chosenShopId"
      LEFT JOIN delivery_partners dp ON dp.id = sh."deliveryPartnerId"
      LEFT JOIN shop_inventory si ON si."variantId" = rd."variantId" AND si."shopId" = rd."chosenShopId"
      ${where}`;

    const [items, countRow, zones] = await Promise.all([
      seq.query(
        `SELECT rd.id, rd."orderId", o."orderNumber", o."createdAt" AS "orderDate", cu.name AS "customerName",
                p.title AS "itemTitle", rd."chosenShopId" AS "shopId",
                s.name AS "shopName", s.city AS "shopCity", s.state AS "shopState", s.address AS "shopAddress",
                s.phone AS "shopPhone", s.email AS "shopEmail", s."isActive" AS "shopActive",
                s."processingTimeMinutes" AS "shopProcessingMins", s."deliveryRadiusKm" AS "shopRadiusKm",
                rd."distanceKm", rd.zone, rd.reason, rd."createdAt",
                sh.status AS "shipmentStatus", sh."shipmentNumber", sh."trackingNumber",
                dp.name AS "partnerName", dp.phone AS "partnerPhone",
                si.quantity AS "availableStock"
         ${base}
         ORDER BY ${sortCol} ${dir}
         LIMIT :limit OFFSET :offset`,
        { type: QueryTypes.SELECT, replacements: { ...repl, limit, offset: (page - 1) * limit } },
      ),
      seq.query<{ c: number }>(`SELECT COUNT(*)::int AS c ${base}`, { type: QueryTypes.SELECT, replacements: repl }),
      // Distinct zones (unfiltered) to populate the Zone filter dropdown.
      seq.query<{ zone: string }>(
        `SELECT DISTINCT zone FROM routing_decisions WHERE zone IS NOT NULL ORDER BY zone`,
        { type: QueryTypes.SELECT },
      ),
    ]);

    // Delivery partners that actually appear on routed shipments — for the filter.
    const partners = await seq.query<{ id: string; name: string }>(
      `SELECT DISTINCT dp.id, dp.name
         FROM order_shipments sh JOIN delivery_partners dp ON dp.id = sh."deliveryPartnerId"
         JOIN routing_decisions rd ON rd."orderId" = sh."orderId" AND rd."chosenShopId" = sh."shopId"
        WHERE dp.name IS NOT NULL ORDER BY dp.name`,
      { type: QueryTypes.SELECT },
    );

    const totalItems = countRow[0]?.c ?? 0;
    return {
      items,
      meta: {
        page, limit, totalItems, totalPages: Math.ceil(totalItems / limit),
        zones: zones.map((z) => z.zone),
        partners,
      },
    };
  }

  @RequirePermissions('orders.view')
  @Get("admin/:id/trail") async trail(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const order = await this.order.findByPk(id, {
      include: [
        { model: User, as: "user", attributes: ["id", "name", "email", "phone", "avatarUrl"] },
        { model: Payment, as: "payment" }
      ]
    });
    if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");

    // Collect history from two sources:
    // 1. Order-level events (placed, cancelled) keyed by orderId
    // 2. Shipment-level events (confirmed, packed, shipped, cannot_fulfill) keyed by shipmentId
    let shipments = await this.ship.findAll({
      where: { orderId: id },
      include: [
        { model: Shop, as: "shop" },
        {
          model: OrderItem,
          as: "items",
          include: [{ model: ProductVariant, as: "variant", include: [ProductMedia, { model: Product, as: "product", include: [ProductMedia] }] }]
        }
      ]
    });

    if (u.role === Role.SHOP_MANAGER) {
      if (!u.shopId) {
        throw new ForbiddenException("AUTH_FORBIDDEN", "Shop Manager must be assigned to a shop");
      }
      const hasAccess = shipments.some(s => s.shopId === u.shopId);
      if (!hasAccess) {
        throw new ForbiddenException("AUTH_FORBIDDEN", "You do not have permission to view this order");
      }
      shipments = shipments.filter(s => s.shopId === u.shopId);
    }

    const shipmentIds = shipments.map((s) => s.id);

    const historyWhere = shipmentIds.length
      ? { [Op.or]: [{ orderId: id }, { shipmentId: shipmentIds }] }
      : { orderId: id };

    const history = await this.hist.findAll({
      where: historyWhere,
      // Resolve actor names from the users table
      include: [{ model: User, as: "actor", attributes: ["id", "name", "email", "avatarUrl"] }],
      order: [["createdAt", "ASC"]],
    });

    const routingWhere: any = { orderId: id };
    if (u.role === Role.SHOP_MANAGER) {
      routingWhere.chosenShopId = u.shopId;
    }

    // Attach the assigned delivery partner (name/phone/status) to each shipment so
    // the override card can show who is delivering — partnerId lives on the shipment
    // but has no eager association, so batch-load and merge here.
    const partnerIds = Array.from(new Set(shipments.map((s) => s.deliveryPartnerId).filter(Boolean))) as string[];
    const partners = partnerIds.length
      ? await this.partnerModel.findAll({ where: { id: partnerIds }, attributes: ["id", "name", "phone", "vehicle", "vehicleNumber", "rating", "status", "isOnline"] })
      : [];
    const partnerById = new Map(partners.map((p) => [p.id, p.toJSON()]));
    const shipmentsJson = shipments.map((s) => ({ ...s.toJSON(), deliveryPartner: s.deliveryPartnerId ? partnerById.get(s.deliveryPartnerId) ?? null : null }));

    return {
      order,
      shipments: shipmentsJson,
      history,
      routing: await this.routing.findAll({
        where: routingWhere,
        include: [
          { model: ProductVariant, as: "variant", include: [ProductMedia, { model: Product, as: "product", include: [ProductMedia] }] },
          { model: Shop, as: "shop" }
        ]
      }),
    };
  }

  @RequirePermissions('fulfillment.assign')
  @Post("admin/shipments/:id/reassign") async reassign(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() body: ReassignDto) {
    return this.orders.reassignShipment(id, body.newShopId, u.sub, body.reason, shopScope(u));
  }
}

@Module({
  imports: [
    SequelizeModule.forFeature([Cart, CartItem, Order, OrderItem, OrderShipment, OrderStatusHistory, RoutingDecision, ShopInventory, StockMovement, ProductVariant, IdempotencyKey, Setting, Invoice, User, AuditLog, CouponRedemption, DeliveryAssignment, Payment, PaymentRefund, DeliveryPartner, EarningWallet, Return, PromotionRedemption]),
    DeliveryEngineModule,
    PromotionsModule,
    WalletModule,
    forwardRef(() => NotificationsModule),
    forwardRef(() => PaymentsModule),
    forwardRef(() => import("@/modules/returns/returns.module").then(m => m.ReturnsModule)),
  ],
  controllers: [OrdersController],
  providers: [OrdersService, PricingService],
  exports: [OrdersService, PricingService],
})
export class OrdersModule {}
