// src/modules/returns/returns.service.ts
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
// App error classes render as proper 4xx (the global filter renders raw Nest
// HttpExceptions as 500). Used for the partial-return validation paths so the
// customer sees the real reason ("You can return at most N more units").
import { BadRequestException as AppBadRequestException, NotFoundException as AppNotFoundException, ForbiddenException as AppForbiddenException } from '@/common/errors/http';
import { InjectModel, InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Return, ReturnMedia, Exchange, OrderItem, User, ShopInventory, StockMovement, Order, OrderShipment, ProductVariant, Product, AuditLog, Brand, PaymentRefund, Payment, InventoryReservation, ProductMedia } from '@/models';
import { JwtPayload } from '@/modules/auth/jwt.strategy';
import { Role } from '@/common/enums/role.enum';
import { OrderStatus } from '@/common/enums/order-status.enum';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { NotificationQueueService } from '@/modules/notifications/notification.queue';
import { NotificationEventType } from '@/common/enums/notification-event.enum';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PageOptionsDto } from '@/common/dto/page-options.dto';
import { paginate } from '@/common/utils/crud.util';
import { Op, cast, col, where as literalWhere } from 'sequelize';
import { PolicyResolutionService } from './policy-resolution.service';
import { WalletService } from '@/modules/wallet/wallet.service';
import { LoyaltyService } from '@/modules/promotions/loyalty.service';
import { computeLineAllocations } from '@/common/utils/order-allocation.util';
import { ExchangeApprovedEvent } from '@/common/events/exchange-approved.event';

/** Physical condition recorded at QC — governs the inventory outcome. */
export const ITEM_CONDITIONS = ['sellable', 'damaged', 'scrap'] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

@Injectable()
export class ReturnsService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @InjectModel(Return) private readonly returnModel: typeof Return,
    @InjectModel(OrderItem) private readonly orderItemModel: typeof OrderItem,
    @InjectModel(User) private readonly userModel: typeof User,
    @InjectModel(ShopInventory) private readonly inventoryModel: typeof ShopInventory,
    @InjectModel(StockMovement) private readonly stockMovementModel: typeof StockMovement,
    private readonly notifications: NotificationsService,
    private readonly queueService: NotificationQueueService,
    private readonly eventEmitter: EventEmitter2,
    @InjectModel(AuditLog) private readonly auditLogModel: typeof AuditLog,
    private readonly policyResolutionService: PolicyResolutionService,
    private readonly wallet: WalletService,
    private readonly loyaltyService: LoyaltyService,
  ) {}

  /**
   * Reverse earned loyalty points proportional to the returned goods VALUE
   * (item price × returned qty) over the order subtotal — NOT the cash refund
   * (REFUND_WALLET_POLICY_WORKFLOW §4.3). This reverses points earned on
   * coupon / gift-card / loyalty-funded items too, even when the cash refund is ₹0.
   * Bounded (loyalty service caps at points actually earned) + best-effort so a
   * loyalty hiccup never blocks the refund.
   */
  private async clawbackLoyaltyForReturn(userId: string, orderId: string, orderItemId: string, returnQty?: number | null) {
    try {
      const order = await Order.findByPk(orderId, { attributes: ['subtotal', 'total'] });
      const item = await this.orderItemModel.findByPk(orderItemId, { attributes: ['price', 'quantity'] });
      if (!order || !item) return;
      const qty = returnQty == null ? Number(item.quantity) : Number(returnQty);
      const returnedValue = Number(item.price) * qty;
      const orderValue = Number(order.subtotal || order.total || 0);
      await this.loyaltyService.clawbackForReturn(userId, orderId, returnedValue, orderValue);
    } catch (e) {
      // Non-fatal: the refund already succeeded; log and move on.
      // eslint-disable-next-line no-console
      console.error('Loyalty clawback for return failed', e);
    }
  }

  private round2(n: number): number { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  /**
   * REFUND_WALLET_POLICY_WORKFLOW §5–§7 — the effective-paid, proportional,
   * bounded refundable amount (to Wallet) for returning `returnQty` units of a line.
   *
   *   refundableBase   = order.walletAmount + order.payableAmount   (the only refundable tenders;
   *                      coupon / gift card / loyalty are consumed and excluded)
   *   share_i          = lineGross_i / Σ lineGross                  (proportional allocation)
   *   lineRefundable   = share_i × refundableBase
   *   amount           = min( perUnit × returnQty ,
   *                           lineRefundable − alreadyRefundedOnLine )   (no over-refund)
   * Returns 0 when the item's effective-paid share is 0 (₹0 out-of-pocket ⇒ not refundable).
   */
  private async computeLineRefundable(order: any, item: any, returnQty: number, t?: any): Promise<number> {
    let lineRefundable: number;
    let alreadyRefunded: number;

    if (item.lineRefundableBase != null) {
      // Immutable per-line snapshot (new orders): read the persisted refundable share
      // and the running refunded total — no recomputation, price-change proof.
      lineRefundable = Number(item.lineRefundableBase);
      alreadyRefunded = Number(item.refundedAmount || 0);
    } else {
      // Legacy fallback (orders placed before the snapshot existed): recompute the
      // proportional share via the SAME shared allocation util, and bound by the sum
      // of prior refunded returns for the line.
      const refundableBase = Number(order.walletAmount || 0) + Number(order.payableAmount || 0);
      if (refundableBase <= 0) return 0;
      const shipments = await OrderShipment.findAll({
        where: { orderId: order.id },
        include: [{ model: this.orderItemModel, as: 'items' }],
        transaction: t,
      });
      const allItems: any[] = shipments.flatMap((s: any) => s.items || []);
      const alloc = computeLineAllocations(
        allItems.map((it) => ({ id: it.id, price: Number(it.price), quantity: Number(it.quantity) })),
        { walletAmount: order.walletAmount, payableAmount: order.payableAmount },
      );
      lineRefundable = alloc.get(item.id)?.lineRefundableBase ?? 0;
      const priorReturns = await this.returnModel.findAll({
        where: { orderItemId: item.id, status: 'refunded' },
        attributes: ['refundAmount'], transaction: t,
      });
      alreadyRefunded = priorReturns.reduce((s: number, r: any) => s + Number(r.refundAmount || 0), 0);
    }

    if (lineRefundable <= 0) return 0;
    const perUnit = lineRefundable / Number(item.quantity || 1);
    const requested = this.round2(perUnit * Number(returnQty));
    const remaining = this.round2(Math.max(0, lineRefundable - alreadyRefunded));
    return this.round2(Math.max(0, Math.min(requested, remaining)));
  }

  /**
   * Once every unit in a shipment has come back and been refunded, the shipment moves to
   * REFUNDED, and the order follows when none of its shipments is still live. Partial
   * returns leave the status alone; the per-item return shows on the order page.
   */
  private async markRefundedIfFullyReturned(orderItemId: string) {
    const line = await this.orderItemModel.findByPk(orderItemId);
    if (!line) return;
    const shipment = await OrderShipment.findByPk(line.shipmentId);
    if (!shipment || ![OrderStatus.DELIVERED, OrderStatus.COMPLETED].includes(shipment.status as OrderStatus)) return;

    const items = await this.orderItemModel.findAll({ where: { shipmentId: shipment.id } });
    const refunded = await this.returnModel.findAll({ where: { orderItemId: items.map((i) => i.id), status: 'refunded' } });
    const allBack = items.every((i) => {
      const units = refunded.filter((r) => r.orderItemId === i.id).reduce((n, r) => n + (r.quantity == null ? i.quantity : Number(r.quantity)), 0);
      return units >= i.quantity;
    });
    if (!allBack) return;

    await shipment.update({ status: OrderStatus.REFUNDED } as any);
    const shipments = await OrderShipment.findAll({ where: { orderId: shipment.orderId } });
    if (shipments.every((s) => [OrderStatus.REFUNDED, OrderStatus.CANCELLED].includes(s.status as OrderStatus))) {
      await Order.update({ status: OrderStatus.REFUNDED } as any, { where: { id: shipment.orderId } });
    }
  }

  /** Maintain the running per-line refunded total (§2/§6) — idempotent-safe caller responsibility. */
  private async bumpLineRefunded(orderItemId: string, amount: number, t?: any) {
    if (!(amount > 0)) return;
    const item = await this.orderItemModel.findByPk(orderItemId, { transaction: t });
    if (item) await item.update({ refundedAmount: this.round2(Number(item.refundedAmount || 0) + amount) } as any, { transaction: t });
  }

  // Helper to enforce scope for shop managers
  private async assertReturnScope(user: JwtPayload, returnId: string, t?: any): Promise<Return> {
    const ret = await this.returnModel.findByPk(returnId, {
      transaction: t,
      lock: t ? t.LOCK.UPDATE : undefined
    });
    if (!ret) throw new NotFoundException('Return not found');
    if (user.role === Role.SHOP_MANAGER) {
      const item = await this.orderItemModel.findByPk(ret.orderItemId, { transaction: t });
      if (!item || item.shopId !== user.shopId) throw new ForbiddenException('AUTH_FORBIDDEN');
    }
    return ret;
  }

  /**
   * Shared where + include set for the admin returns queue (flat list, grouped
   * view and CSV all run the same filter/scope/search so they never diverge).
   */
  private buildAdminReturnsQuery(user: JwtPayload, opts: PageOptionsDto): { where: any; includeParams: any[] } {
    const where: any = {};
    if (opts.status) where.status = opts.status;

    const includeParams: any[] = [
      {
        model: OrderItem,
        include: [{
          model: ProductVariant,
          // paranoid:false — returns outlive their catalog entries. Without this a
          // soft-deleted product/variant joins as null and the row renders as
          // "Unknown Product". Read-only: no change to filtering or response shape.
          paranoid: false,
          include: [
            // separate:true — ProductMedia is hasMany. Joined inline it would
            // multiply rows, and because this query runs with subQuery:false the
            // LIMIT would then apply to flattened join rows instead of returns
            // (20 media rows of one product = 1 return per page). A separate
            // query keeps the main join 1:1 so pagination stays correct.
            { model: ProductMedia, separate: true, limit: 1, order: [['sortOrder', 'ASC']] },
            {
              model: Product,
              paranoid: false,
              include: [
                Brand,
                { model: ProductMedia, separate: true, limit: 1, order: [['sortOrder', 'ASC']] }
              ]
            }
          ]
        },
        // belongsTo chain (1:1) — safe to join inline, and it powers
        // order-number search plus surfaces the order number + date to the queue UI.
        {
          model: OrderShipment,
          include: [{ model: Order, attributes: ['id', 'orderNumber', 'createdAt', 'placedAt'] }]
        }]
      },
      {
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email']
      },
      {
        model: Exchange
      }
    ];

    if (user.role === Role.SHOP_MANAGER) {
      // A manager with no assigned shop can't be scoped — fail cleanly (403) rather
      // than build a `where: { shopId: undefined }` that crashes Sequelize (500).
      if (!user.shopId) {
        throw new AppForbiddenException('AUTH_FORBIDDEN', 'No shop is assigned to your account. Contact an administrator.');
      }
      includeParams[0].where = { shopId: user.shopId };
    }

    if (opts.q) {
      const term = `%${opts.q.trim()}%`;
      where[Op.or] = [
        // `returns.id` is uuid — Op.iLike on it throws
        // "operator does not exist: uuid ~~* unknown". Cast to text first.
        literalWhere(cast(col('Return.id'), 'text'), { [Op.iLike]: term } as any),
        literalWhere(cast(col('orderItem.shipment.order.id'), 'text'), { [Op.iLike]: term } as any),
        { '$orderItem.shipment.order.orderNumber$': { [Op.iLike]: term } },
        // SKU / product name: live catalog first, order-item snapshot as fallback
        // so historical rows stay searchable after a product is deleted.
        { '$orderItem.variant.sku$': { [Op.iLike]: term } },
        { '$orderItem.sku$': { [Op.iLike]: term } },
        { '$orderItem.variant.product.title$': { [Op.iLike]: term } },
        { '$orderItem.productName$': { [Op.iLike]: term } },
        { '$user.name$': { [Op.iLike]: term } },
        { '$user.email$': { [Op.iLike]: term } },
      ];
    }

    return { where, includeParams };
  }

  async getAdminReturns(user: JwtPayload, opts: PageOptionsDto) {
    const { where, includeParams } = this.buildAdminReturnsQuery(user, opts);
    return paginate(this.returnModel, opts, where, includeParams, {
      subQuery: false,
      order: [['id', opts.order || 'DESC']]
    });
  }

  /**
   * Admin queue grouped by ORDER. Returns paginate at the order level: each entry
   * is one order with all of its (filtered) return/replacement requests nested,
   * so the console can render an order-friendly accordion instead of a flat list.
   * Filters/search/scope are identical to the flat list. Same product with
   * multiple partial requests → multiple entries in the order's `returns` array.
   */
  async getAdminReturnsGrouped(user: JwtPayload, opts: PageOptionsDto) {
    const { where, includeParams } = this.buildAdminReturnsQuery(user, opts);
    // Fetch all matching returns (newest first) and group in memory. The returns
    // volume per tenant is modest; the cap is a runaway backstop.
    const rows = await this.returnModel.findAll({
      where,
      include: includeParams,
      subQuery: false,
      order: [['createdAt', 'DESC']],
      limit: 2000,
    });

    const groupsMap = new Map<string, any>();
    for (const row of rows) {
      const rj: any = row.toJSON();
      const order = rj.orderItem?.shipment?.order;
      const orderId = order?.id || `unknown-${rj.orderItemId}`;
      let g = groupsMap.get(orderId);
      if (!g) {
        g = {
          orderId,
          orderNumber: order?.orderNumber ?? null,
          orderDate: order?.placedAt ?? order?.createdAt ?? null,
          customer: rj.user ? { id: rj.user.id, name: rj.user.name, email: rj.user.email } : null,
          latestRequestAt: rj.createdAt,
          returns: [] as any[],
        };
        groupsMap.set(orderId, g);
      }
      g.returns.push(rj);
      if (rj.createdAt && new Date(rj.createdAt).getTime() > new Date(g.latestRequestAt).getTime()) {
        g.latestRequestAt = rj.createdAt;
      }
    }

    const allGroups = Array.from(groupsMap.values()).sort(
      (a, b) => new Date(b.latestRequestAt).getTime() - new Date(a.latestRequestAt).getTime(),
    );

    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 10;
    const page = Number(opts.page) > 0 ? Number(opts.page) : 1;
    const totalItems = allGroups.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const start = (page - 1) * limit;
    const pageGroups = allGroups.slice(start, start + limit).map((g) => ({
      ...g,
      requestCount: g.returns.length,
      productCount: new Set(g.returns.map((r: any) => r.orderItem?.variantId || r.orderItemId)).size,
    }));

    return {
      items: pageGroups,
      meta: { page, limit, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
    };
  }

  async getAdminReturnDetail(user: JwtPayload, returnId: string) {
    const ret = await this.returnModel.findByPk(returnId, {
      include: [
        ReturnMedia,
        // The list endpoint already includes this; the detail endpoint did not, so
        // the UI could not tell a replacement from a plain return — it rendered
        // return-only steps and a meaningless status. Read-only: same route, same
        // shape as the list payload.
        Exchange,
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email']
        },
        {
          model: OrderItem,
          include: [
            {
              model: ProductVariant,
              // See getAdminReturns — soft-deleted catalog rows must still resolve.
              paranoid: false,
              include: [
                ProductMedia,
                { model: Product, paranoid: false, include: [Brand, ProductMedia] }
              ]
            },
            {
              model: OrderShipment,
              include: [
                {
                  model: Order,
                  include: [Payment]
                }
              ]
            }
          ]
        }
      ]
    });

    if (!ret) throw new NotFoundException('Return not found');

    if (user.role === Role.SHOP_MANAGER) {
      const item = ret.orderItem;
      if (!item || item.shopId !== user.shopId) throw new ForbiddenException('AUTH_FORBIDDEN');
    }

    // Include payment refunds if exists
    let refundInfo: PaymentRefund[] | null = null;
    const orderItemAny = ret.orderItem as any;
    if (orderItemAny?.shipment?.order?.payment) {
      refundInfo = await PaymentRefund.findAll({ where: { paymentId: orderItemAny.shipment.order.payment.id } });
    }

    // Include audit logs for timeline
    const auditLogs = await AuditLog.findAll({
      where: { entity: 'Return', entityId: ret.id },
      order: [['createdAt', 'DESC']],
      include: [{ model: User, as: 'actor', attributes: ['id', 'name'] }]
    });

    return {
      returnDetail: ret,
      refunds: refundInfo,
      timeline: auditLogs
    };
  }

  /**
   * How many units of an order item are still eligible to be returned/replaced.
   * `remaining = purchased − Σ(quantity of every non-rejected return for the item)`.
   * A rejected return frees its quantity back. Legacy returns carry `quantity =
   * null`, which counts as the whole line (their orderItem's quantity).
   */
  async getReturnEligibility(orderItemId: string, purchasedQty: number, t?: any): Promise<{ purchased: number; returned: number; remaining: number }> {
    const priorReturns = await this.returnModel.findAll({
      where: { orderItemId, status: { [Op.ne]: 'rejected' } },
      attributes: ['id', 'quantity'],
      transaction: t,
    });
    const returned = priorReturns.reduce((sum, r) => sum + (r.quantity == null ? purchasedQty : Number(r.quantity)), 0);
    return { purchased: purchasedQty, returned, remaining: Math.max(0, purchasedQty - returned) };
  }

  /**
   * A return needs a delivered item still inside the policy's window. The window
   * was resolved but never compared, so a return 20+ days after delivery against
   * a 7-day policy went straight through — as did a return on an undelivered item.
   */
  private assertWithinReturnWindow(item: OrderItem, policy: { returnWindowDays?: number | null }) {
    const shipment: any = (item as any).shipment;
    const delivered = shipment && ["delivered", "completed"].includes(shipment.status) && shipment.deliveredAt;
    if (!delivered) {
      throw new AppBadRequestException('BAD_REQUEST', `${item.productName || 'This item'} has not been delivered yet, so it cannot be returned.`);
    }
    const days = Number(policy.returnWindowDays ?? 7);
    const closesAt = new Date(shipment.deliveredAt).getTime() + days * 24 * 3600_000;
    if (Date.now() > closesAt) {
      throw new AppBadRequestException('BAD_REQUEST', `The ${days}-day return window for ${item.productName || 'this item'} closed on ${new Date(closesAt).toLocaleDateString('en-IN')}.`);
    }
  }

  async createReturn(user: JwtPayload, data: any): Promise<Return> {
    const item = await this.orderItemModel.findByPk(data.orderItemId, {
      include: [
        { model: ProductVariant, include: [Product] },
        { model: OrderShipment, include: [Order] },
      ]
    });
    if (!item) throw new NotFoundException('Order item not found');

    // Ownership: a customer may only open a return against their own order item.
    // The Return is created with userId = caller, so without this check a caller
    // could open (and then exchange/refund) a return on someone else's purchase.
    if (user.role === Role.CUSTOMER && (item as any).shipment?.order?.userId !== user.sub) {
      throw new ForbiddenException('AUTH_FORBIDDEN');
    }

    const variant: any = item.variant;
    if (variant && variant.product) {
      const policy = await this.policyResolutionService.resolvePolicy(variant.productId, variant.product.categoryId);
      if (!policy.isReturnable) {
        throw new BadRequestException('This product is not eligible for return.');
      }
      this.assertWithinReturnWindow(item, policy);
    }

    // Quantity ceiling: default to the whole remaining eligible quantity when the
    // client doesn't specify one (preserves the legacy whole-line behaviour), and
    // never allow more units than are still returnable across prior requests.
    const { remaining } = await this.getReturnEligibility(data.orderItemId, Number(item.quantity));
    if (remaining <= 0) {
      throw new AppBadRequestException('BAD_REQUEST', 'All units of this item have already been returned.');
    }
    const requestedQty = data.quantity != null ? Math.floor(Number(data.quantity)) : remaining;
    if (!(requestedQty >= 1)) {
      throw new AppBadRequestException('BAD_REQUEST', 'Return quantity must be at least 1.');
    }
    if (requestedQty > remaining) {
      throw new AppBadRequestException('BAD_REQUEST', `You can return at most ${remaining} more unit(s) of this item.`);
    }

    const ret = await this.returnModel.create({ ...data, quantity: requestedQty, userId: user.sub } as any);
    await this.auditLogModel.create({
      actorId: user.sub,
      action: 'Return Requested',
      entity: 'Return',
      entityId: ret.id
    } as any);

    if (item && item.shopId) {
      const managers = await this.userModel.findAll({ where: { role: Role.SHOP_MANAGER, shopId: item.shopId } });
      for (const m of managers) {
        await this.queueService.enqueue(m.id, NotificationEventType.RETURN_REQUESTED, { returnId: ret.id });
      }
    }
    return ret;
  }

  /**
   * Multi-item request: create one Return per selected order item (and, for a
   * replacement batch, one Exchange per item) atomically. Each item is validated
   * for ownership, returnability and remaining-quantity ceiling before anything is
   * written, so a single ineligible line rolls the whole batch back — the customer
   * never ends up with a half-created request.
   */
  async createReturnsBatch(user: JwtPayload, dto: { items: { orderItemId: string; quantity: number }[]; reason: string; method?: string; type?: 'return' | 'exchange' }): Promise<Return[]> {
    const isExchange = dto.type === 'exchange';
    if (!dto.items?.length) throw new AppBadRequestException('BAD_REQUEST', 'Select at least one item to return.');

    // Guard against the same order item appearing twice in one batch — otherwise
    // the two lines' ceilings are validated independently and could jointly exceed
    // the remaining quantity.
    const seen = new Set<string>();
    for (const it of dto.items) {
      if (seen.has(it.orderItemId)) throw new AppBadRequestException('BAD_REQUEST', 'The same item was selected more than once.');
      seen.add(it.orderItemId);
    }

    const created = await this.sequelize.transaction(async (t) => {
      const results: { ret: Return; shopId: string }[] = [];
      for (const line of dto.items) {
        const item = await this.orderItemModel.findByPk(line.orderItemId, {
          include: [
            { model: ProductVariant, include: [Product] },
            { model: OrderShipment, include: [Order] },
          ],
          transaction: t,
        });
        if (!item) throw new AppNotFoundException('NOT_FOUND', `Order item ${line.orderItemId} not found`);

        if (user.role === Role.CUSTOMER && (item as any).shipment?.order?.userId !== user.sub) {
          throw new AppForbiddenException('AUTH_FORBIDDEN');
        }

        const variant: any = item.variant;
        if (variant?.product) {
          const policy = await this.policyResolutionService.resolvePolicy(variant.productId, variant.product.categoryId);
          if (isExchange ? !policy.isReplaceable : !policy.isReturnable) {
            throw new AppBadRequestException('BAD_REQUEST', `${item.productName || 'This product'} is not eligible for ${isExchange ? 'replacement' : 'return'}.`);
          }
          this.assertWithinReturnWindow(item, policy);
        }

        const { remaining } = await this.getReturnEligibility(line.orderItemId, Number(item.quantity), t);
        const qty = Math.floor(Number(line.quantity));
        if (!(qty >= 1)) throw new AppBadRequestException('BAD_REQUEST', `Quantity for ${item.productName || 'an item'} must be at least 1.`);
        if (qty > remaining) {
          throw new AppBadRequestException('BAD_REQUEST', `You can ${isExchange ? 'replace' : 'return'} at most ${remaining} more unit(s) of ${item.productName || 'this item'}.`);
        }

        // For a replacement, confirm the fulfilling shop actually has the units.
        if (isExchange) {
          const avail = await this.getReplacementAvailability(user, line.orderItemId, undefined, qty);
          if (!avail.inStock) {
            throw new AppBadRequestException('INV_OUT_OF_STOCK', `${item.productName || 'This item'} is out of stock for replacement (need ${qty}, ${avail.available} available).`);
          }
        }

        const ret = await this.returnModel.create({
          orderItemId: line.orderItemId,
          userId: user.sub,
          reason: dto.reason,
          method: dto.method || 'pickup',
          quantity: qty,
        } as any, { transaction: t });

        if (isExchange) {
          await Exchange.create({ returnId: ret.id, replacementVariantId: item.variantId, quantity: qty } as any, { transaction: t });
        }

        await this.auditLogModel.create({
          actorId: user.sub,
          action: isExchange ? 'Exchange Requested' : 'Return Requested',
          entity: 'Return',
          entityId: ret.id,
        } as any, { transaction: t });

        results.push({ ret, shopId: item.shopId });
      }
      return results;
    });

    // Notify shop managers after commit (best-effort, outside the transaction).
    for (const { ret, shopId } of created) {
      if (!shopId) continue;
      const managers = await this.userModel.findAll({ where: { role: Role.SHOP_MANAGER, shopId } });
      for (const m of managers) {
        await this.queueService.enqueue(m.id, NotificationEventType.RETURN_REQUESTED, { returnId: ret.id });
      }
    }
    return created.map((c) => c.ret);
  }

  async approveReturn(user: JwtPayload, returnId: string): Promise<{ approved: boolean }> {
    const ret = await this.assertReturnScope(user, returnId);
    if (ret.status !== 'requested') throw new BadRequestException('Return is not in requested state');
    
    const exchange = await Exchange.findOne({ where: { returnId: ret.id } });
    
    await this.sequelize.transaction(async t => {
      await ret.update({ status: 'approved' }, { transaction: t });
      
      if (exchange) {
        await exchange.update({ status: 'APPROVED' }, { transaction: t });
        const item = await this.orderItemModel.findByPk(ret.orderItemId, { transaction: t });
        if (item) {
          // Emit only after commit: the listener opens its own transaction to
          // reserve stock, so emitting inline races this one — it could read a
          // pre-APPROVED row, or have its WAITING_FOR_REPLACEMENT_STOCK write
          // clobbered by this transaction's APPROVED update.
          // Reserve only the units being replaced (partial replacement); legacy
          // exchanges with no quantity fall back to the whole line.
          const replaceQty = exchange.quantity == null ? item.quantity : Number(exchange.quantity);
          t.afterCommit(() => {
            this.eventEmitter.emit('exchange.approved', new ExchangeApprovedEvent(
              exchange.id,
              item.shopId,
              exchange.replacementVariantId,
              replaceQty
            ));
          });
        }
      }

      await this.auditLogModel.create({
        actorId: user.sub,
        action: exchange ? 'Exchange Approved' : 'Return Approved',
        entity: 'Return',
        entityId: ret.id
      } as any, { transaction: t });
    });

    await this.notifications.notify(ret.userId, exchange ? 'Exchange approved' : 'Return approved', "Your request was approved. We'll arrange pickup shortly.");
    return { approved: true };
  }

  async rejectReturn(user: JwtPayload, returnId: string, reason: string): Promise<{ rejected: boolean }> {
    const ret = await this.assertReturnScope(user, returnId);
    // 'inspection_failed' is now a valid entry point: a failed QC used to leave the
    // request stranded with no way to close it. Rejecting is the "no refund" exit.
    if (!['requested', 'inspection_failed'].includes(ret.status)) {
      throw new BadRequestException(`Cannot reject a return in status: ${ret.status}`);
    }
    await this.returnModel.update({ status: 'rejected', inspectionComments: reason } as any, { where: { id: returnId } });
    await this.auditLogModel.create({
      actorId: user.sub,
      action: 'Return Rejected',
      entity: 'Return',
      entityId: ret.id
    } as any);
    await this.notifications.notify(ret.userId, 'Return rejected', `Your return request was rejected. Reason: ${reason}`);
    return { rejected: true };
  }

  /**
   * Books a courier pickup slot.
   *
   * There is no live carrier integration (the carrier adapter is unwired), so
   * rather than pretend a courier was dispatched we persist an explicit,
   * trackable scheduling state: status `pickup_scheduled` + `pickupScheduledAt`,
   * an audit entry, and a dated customer notification. Confirming the pickup
   * later is still a human action.
   */
  async schedulePickup(user: JwtPayload, returnId: string, scheduledAt: string): Promise<{ scheduled: boolean; pickupScheduledAt: Date }> {
    const ret = await this.assertReturnScope(user, returnId);

    if (ret.method !== 'pickup') {
      throw new BadRequestException('This return is a self-drop — no courier pickup is required.');
    }
    if (!['approved', 'pickup_scheduled'].includes(ret.status)) {
      throw new BadRequestException(`Cannot schedule pickup for a return in status: ${ret.status}`);
    }

    const when = new Date(scheduledAt);
    if (isNaN(when.getTime())) throw new BadRequestException('scheduledAt must be a valid date.');
    if (when.getTime() < Date.now()) throw new BadRequestException('scheduledAt must be in the future.');

    const exchange = await Exchange.findOne({ where: { returnId: ret.id } });

    await this.sequelize.transaction(async t => {
      await ret.update({ status: 'pickup_scheduled', pickupScheduledAt: when }, { transaction: t });

      // Don't clobber a parked replacement — it still has no stock reserved.
      if (exchange && exchange.status !== 'WAITING_FOR_REPLACEMENT_STOCK') {
        await exchange.update({ status: 'WAITING_FOR_PICKUP' }, { transaction: t });
      }

      await this.auditLogModel.create({
        actorId: user.sub,
        action: 'Pickup Scheduled',
        entity: 'Return',
        entityId: ret.id,
        after: { pickupScheduledAt: when },
      } as any, { transaction: t });
    });

    await this.notifications.notify(
      ret.userId,
      'Pickup scheduled',
      `Our courier is scheduled to collect your item on ${when.toDateString()}. Please keep it packed and ready.`,
    );

    return { scheduled: true, pickupScheduledAt: when };
  }

  async confirmPickup(user: JwtPayload, returnId: string, status: 'picked_up' | 'received_at_shop' = 'picked_up'): Promise<{ success: boolean }> {
    // Shop-level authorization: assertReturnScope resolves the return's order item
    // and rejects a shop manager whose shopId doesn't match. Previously this used a
    // bare findByPk, letting any manager confirm pickup on another shop's return.
    const ret = await this.assertReturnScope(user, returnId);

    const exchange = await Exchange.findOne({ where: { returnId: ret.id } });

    await this.sequelize.transaction(async t => {
      await ret.update({ status }, { transaction: t });
      
      // Preserve the blocked state: a replacement parked for stock must stay
      // visible as WAITING_FOR_REPLACEMENT_STOCK until stock actually arrives.
      // Overwriting it with PICKED_UP hid the blockage from operators and from
      // the restock sweep.
      if (exchange && status === 'picked_up' && exchange.status !== 'WAITING_FOR_REPLACEMENT_STOCK') {
        await exchange.update({ status: 'PICKED_UP' }, { transaction: t });
      }

      await this.auditLogModel.create({
        actorId: user.sub,
        action: status === 'picked_up' ? 'Pickup Confirmed' : 'Received at Shop',
        entity: 'Return',
        entityId: ret.id
      } as any, { transaction: t });
    });

    if (status === 'picked_up') {
      await this.notifications.notify(ret.userId, exchange ? 'Exchange picked up' : 'Return picked up', "We've collected your item.");
    } else if (status === 'received_at_shop') {
      await this.notifications.notify(ret.userId, 'Item received at shop', "Your item has reached our warehouse and is pending inspection.");
    }
    return { success: true };
  }

  /**
   * @param condition Physical state of the returned item, decided at QC. It governs
   * the INVENTORY outcome only — the refund/replacement decision still follows
   * `status`, because a genuinely faulty item is still a valid return.
   *   sellable -> back into sellable stock
   *   damaged  -> quarantined: NOT restocked, recorded for inspection/write-off
   *   scrap    -> discarded:  NOT restocked
   * Defaults to 'sellable', preserving the previous behaviour for callers that
   * don't pass it.
   */
  async inspectReturn(
    user: JwtPayload,
    returnId: string,
    status: 'passed' | 'failed',
    comments?: string,
    deductRestockingFee: number = 0,
    condition: ItemCondition = 'sellable',
  ): Promise<{ success: boolean }> {
    if (!ITEM_CONDITIONS.includes(condition)) {
      throw new BadRequestException(`Invalid item condition: ${condition}. Expected one of: ${ITEM_CONDITIONS.join(', ')}`);
    }
    return await this.sequelize.transaction(async (t) => {
      if (process.env.NODE_ENV === 'test' || process.env.DEBUG === 'true') {
        console.log(`[DEBUG] Transaction started for inspectReturn: returnId=${returnId}`);
      }
      const ret = await this.assertReturnScope(user, returnId, t);
      if (process.env.NODE_ENV === 'test' || process.env.DEBUG === 'true') {
        console.log(`[DEBUG] Row lock acquired for Return: returnId=${returnId}`);
      }
      if (ret.status !== 'received_at_shop' && ret.status !== 'picked_up' && ret.status !== 'picked') {
        throw new BadRequestException('Return must be received at shop before inspection');
      }

      const newStatus = status === 'passed' ? 'inspection_passed' : 'inspection_failed';
      await ret.update({ status: newStatus, inspectionComments: comments }, { transaction: t });

      const item = await this.orderItemModel.findByPk(ret.orderItemId, {
        include: [OrderShipment],
        transaction: t
      });
      if (!item) throw new NotFoundException('Order item not found');

      // Units this return covers — a partial return only restocks/refunds the
      // quantity requested. Legacy returns (quantity null) = the whole line.
      const retQty = ret.quantity == null ? item.quantity : Number(ret.quantity);

      // Update Inventory — driven by the QC condition, not just pass/fail.
      // Only 'sellable' goods return to sellable stock; damaged/scrap are recorded
      // in the ledger but must never become sellable again. `disposition` is a
      // human-readable summary of what happened to the goods, recorded on the
      // audit trail so an auditor can tell restock from quarantine from scrap.
      let disposition: string;
      if (status === 'passed') {
        if (condition === 'sellable') {
          const [invItem] = await this.inventoryModel.findOrCreate({
            where: { shopId: item.shopId, variantId: item.variantId },
            defaults: { shopId: item.shopId, variantId: item.variantId, quantity: 0, isActive: true } as any,
            transaction: t,
          });
          await invItem.increment('quantity', { by: retQty, transaction: t });
          await this.stockMovementModel.create({
            shopId: item.shopId,
            variantId: item.variantId,
            type: 'RETURN_RESTOCK_SELLABLE',
            quantity: retQty,
            reason: comments || 'Customer return restocked',
            referenceType: 'RETURN',
            referenceId: ret.id,
          } as any, { transaction: t });
          disposition = `Restocked to sellable inventory (+${retQty} unit${retQty === 1 ? '' : 's'})`;
        } else {
          const movementType = condition === 'damaged' ? 'RETURN_QUARANTINE' : 'RETURN_SCRAPPED';
          await this.stockMovementModel.create({
            shopId: item.shopId,
            variantId: item.variantId,
            type: movementType,
            quantity: retQty,
            reason: comments || (condition === 'damaged' ? 'Customer return quarantined' : 'Customer return scrapped'),
            referenceType: 'RETURN',
            referenceId: ret.id,
          } as any, { transaction: t });
          disposition = condition === 'damaged'
            ? `Moved to quarantine — ${retQty} unit${retQty === 1 ? '' : 's'} withheld from sellable stock`
            : `Scrapped / discarded — ${retQty} unit${retQty === 1 ? '' : 's'}`;
        }
      } else {
        await this.stockMovementModel.create({
          shopId: item.shopId,
          variantId: item.variantId,
          type: 'RETURN_DAMAGED',
          quantity: retQty,
          reason: comments || 'Customer return damaged',
          referenceType: 'RETURN',
          referenceId: ret.id,
        } as any, { transaction: t });
        disposition = `Failed QC — ${retQty} unit${retQty === 1 ? '' : 's'} not restocked`;
      }

      // Notify customer
      t.afterCommit(() => {
        this.notifications.notify(ret.userId, 'Return Inspection Completed', `Inspection ${status}. Processing next steps.`).catch(e => console.error(e));
      });

      await this.auditLogModel.create({
        actorId: user.sub,
        action: status === 'passed' ? 'Inspection Passed' : 'Inspection Failed',
        entity: 'Return',
        entityId: ret.id,
        // Record the QC condition + inventory disposition (in the `after` JSONB —
        // AuditLog has no `notes` column) so the audit trail distinguishes
        // restock / quarantine / scrap outcomes.
        after: { condition, disposition, quantity: retQty },
      } as any, { transaction: t });

      // Fire Event for Refund or Exchange Fulfillment
      if (status === 'passed') {
        const exchange = await Exchange.findOne({ where: { returnId: ret.id }, transaction: t });
        
        if (exchange) {
          await exchange.update({ status: 'QC_PASSED' }, { transaction: t });
          
          await this.auditLogModel.create({
            actorId: user.sub,
            action: 'Exchange QC Passed',
            entity: 'Return',
            entityId: ret.id
          } as any, { transaction: t });

          t.afterCommit(() => {
            if (process.env.NODE_ENV === 'test' || process.env.DEBUG === 'true') {
              console.log(`[DEBUG] Transaction committed, emitting exchange.qc_passed for exchangeId=${exchange.id}`);
            }
            this.eventEmitter.emit('exchange.qc_passed', {
              exchangeId: exchange.id,
              returnId: ret.id,
              shopId: item.shopId
            });
          });
        } else {
          await ret.update({ status: 'refund_processing', refundDestination: 'WALLET' } as any, { transaction: t });

          // Policy: refund the EFFECTIVE-PAID share (wallet + cash) to the customer
          // WALLET — never the full item price and never to card/UPI/source.
          const orderId = (item as any).shipment.orderId;
          const order = await Order.findByPk(orderId, { transaction: t });
          const effective = order ? await this.computeLineRefundable(order, item, retQty, t) : 0;
          const refundAmount = this.round2(Math.max(0, effective - Number(deductRestockingFee || 0)));

          await this.auditLogModel.create({
            actorId: user.sub,
            action: 'Refund Requested',
            entity: 'Return',
            entityId: ret.id,
            after: { refundAmount, destination: 'WALLET', restockingFee: deductRestockingFee },
          } as any, { transaction: t });

          const userId = ret.userId; const rid = ret.id; const shopId = item.shopId;
          t.afterCommit(async () => {
            try {
              if (refundAmount > 0) {
                await this.wallet.credit(userId, refundAmount, {
                  type: 'refund',
                  category: 'REFUND',
                  reason: `Refund for return ${rid}`,
                  idempotencyKey: `return-refund-${rid}`,
                  returnId: rid, orderId,
                });
              }
              // Finalize via the existing pipeline: sets status=refunded, claws back loyalty
              // (returns.handleRefundCompleted) and shop earnings (FinanceService). No gateway leg.
              this.eventEmitter.emit('RefundCompleted', {
                returnId: rid, amount: refundAmount, transactionId: `wallet_${rid}`, orderId, shopId,
              });
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error('Auto wallet refund failed', e);
            }
          });
        }
      } else {
        // Handle Exchange QC_FAILED
        const exchange = await Exchange.findOne({ where: { returnId: ret.id }, transaction: t });
        
        if (exchange) {
          await exchange.update({ status: 'QC_FAILED' }, { transaction: t });
          
          await this.auditLogModel.create({
            actorId: user.sub,
            action: 'Exchange QC Failed',
            entity: 'Return',
            entityId: ret.id
          } as any, { transaction: t });

          // We need reservationId for the payload
          const reservation = await this.sequelize.models.InventoryReservation.findOne({ 
            where: { referenceId: exchange.id, status: 'RESERVED' }, 
            transaction: t 
          });

          t.afterCommit(() => {
            if (process.env.NODE_ENV === 'test' || process.env.DEBUG === 'true') {
              console.log(`[DEBUG] Transaction committed, emitting exchange.qc_failed for exchangeId=${exchange.id}`);
            }
            this.eventEmitter.emit('exchange.qc_failed', {
              exchangeId: exchange.id,
              returnId: ret.id,
              reservationId: (reservation as any)?.id || null,
              shopId: item.shopId,
              variantId: item.variantId,
              reason: 'QC_FAILED'
            });
          });
        }
      }

      return { success: true };
    });
  }

  @OnEvent('RefundCompleted')
  async handleRefundCompleted(payload: { returnId: string, amount: number, transactionId: string, orderId: string, shopId: string }) {
    const ret = await this.returnModel.findByPk(payload.returnId);
    if (!ret) return;
    // Idempotency: a duplicate RefundCompleted must not double-claw loyalty points.
    if (ret.status === 'refunded') return;

    await ret.update({
      status: 'refunded',
      refundAmount: payload.amount,
      refundTransactionId: payload.transactionId
    });

    // Maintain the running per-line refunded total (§2).
    await this.bumpLineRefunded(ret.orderItemId, Number(payload.amount || 0));
    await this.markRefundedIfFullyReturned(ret.orderItemId);

    await this.auditLogModel.create({
      actorId: ret.userId, // System acting on behalf of user or simply missing actor
      action: 'Refund Completed',
      entity: 'Return',
      entityId: ret.id
    } as any);

    // Reverse loyalty points earned on the returned goods VALUE (not the cash refund).
    await this.clawbackLoyaltyForReturn(ret.userId, payload.orderId, ret.orderItemId, ret.quantity);
  }

  /**
   * Discretionary refund by Admin/Finance.
   *
   * The happy path still refunds automatically on QC pass — this is the manual
   * exit for a FAILED inspection (goodwill / customer resolution), which
   * previously had no route forward at all. It reuses the same RefundRequested
   * pipeline, so gateway handling and ledger effects are identical.
   */
  async processRefund(user: JwtPayload, returnId: string, refundDto: any): Promise<{ refunded: boolean; amount: number }> {
    const ret = await this.assertReturnScope(user, returnId);

    if (['refunded', 'refund_processing'].includes(ret.status)) {
      throw new BadRequestException(`A refund is already ${ret.status === 'refunded' ? 'completed' : 'in progress'} for this return.`);
    }
    if (!['inspection_failed', 'inspection_passed', 'received_at_shop', 'picked_up'].includes(ret.status)) {
      throw new BadRequestException(`Cannot refund a return in status: ${ret.status}`);
    }

    const item = await this.orderItemModel.findByPk(ret.orderItemId, { include: [OrderShipment] });
    if (!item) throw new NotFoundException('Order item not found');

    // Only the returned units are refundable (partial return); legacy = whole line.
    const retQty = ret.quantity == null ? item.quantity : Number(ret.quantity);

    // Policy: refundable = EFFECTIVE-PAID share (wallet + cash), never the full item price.
    const order = await Order.findByPk((item as any).shipment.orderId);
    const maxRefundable = order ? await this.computeLineRefundable(order, item, retQty) : 0;
    if (maxRefundable <= 0) {
      throw new BadRequestException('This item was fully paid using coupon / gift card / loyalty (₹0 out-of-pocket) and is not eligible for a refund.');
    }
    // Admin may refund less (goodwill / partial) but never more than the effective-paid share.
    const amount = this.round2(refundDto?.amount != null ? Number(refundDto.amount) : maxRefundable);
    if (!(amount > 0) || amount > maxRefundable) {
      throw new BadRequestException(`Refund amount must be between 0 and ${maxRefundable.toFixed(2)} (effective paid).`);
    }

    // A replacement can't also be refunded — cancel it and release any hold.
    const exchange = await Exchange.findOne({ where: { returnId: ret.id } });
    if (exchange && exchange.status !== 'QC_FAILED') {
      const reservation = await InventoryReservation.findOne({
        where: { referenceId: exchange.id, status: 'RESERVED' },
      });
      await exchange.update({ status: 'QC_FAILED' });
      this.eventEmitter.emit('exchange.qc_failed', {
        exchangeId: exchange.id,
        returnId: ret.id,
        reservationId: reservation?.id ?? null,
        shopId: item.shopId,
        variantId: item.variantId,
        reason: 'REPLACEMENT_CANCELLED_REFUND_ISSUED',
      });
    }

    // Wallet is the ONLY refund destination (never card / UPI / source).
    await this.wallet.credit(ret.userId, amount, {
      type: 'refund',
      category: 'REFUND',
      reason: `Refund for return ${ret.id}`,
      idempotencyKey: `return-refund-${ret.id}`,
      returnId: ret.id, orderId: (item as any).shipment.orderId,
    });
    await ret.update({ status: 'refunded', refundAmount: amount, refundDestination: 'WALLET' } as any);
    await this.auditLogModel.create({
      actorId: user.sub,
      action: 'Refund Credited to Wallet',
      entity: 'Return',
      entityId: ret.id,
      after: { amount, method: 'wallet', reason: refundDto?.reason ?? null },
    } as any);
    await this.notifications.notify(ret.userId, 'Refund credited to wallet', `₹${amount.toFixed(2)} has been added to your wallet balance.`);
    // Maintain the running per-line refunded total (§2).
    await this.bumpLineRefunded(ret.orderItemId, amount);
    await this.markRefundedIfFullyReturned(ret.orderItemId);
    // Same shop-side effect as the automatic path: debit the shop's earnings for this refund.
    // returns.handleRefundCompleted skips it (already refunded); FinanceService writes the ledger.
    this.eventEmitter.emit('RefundCompleted', {
      returnId: ret.id, amount, transactionId: `wallet_${ret.id}`, orderId: (item as any).shipment.orderId, shopId: item.shopId,
    });
    // Reverse loyalty points earned on the returned goods VALUE (not the cash refund).
    await this.clawbackLoyaltyForReturn(ret.userId, (item as any).shipment.orderId, ret.orderItemId, retQty);
    return { refunded: true, amount };
  }

  async processExchange(user: JwtPayload, returnId: string, data: any): Promise<Exchange> {
    const ret = await this.returnModel.findOne({ 
      where: { id: returnId, userId: user.sub },
      include: [{ model: OrderItem, include: [{ model: ProductVariant, include: [Product] }] }]
    });
    if (!ret) throw new NotFoundException('Return not found');

    const item: any = ret.orderItem;
    if (item && item.variant && item.variant.product) {
      const policy = await this.policyResolutionService.resolvePolicy(item.variant.productId, item.variant.product.categoryId);
      if (!policy.isReplaceable) {
        throw new BadRequestException('This product is not eligible for exchange.');
      }
    }

    // Replacement quantity: default to the return's quantity (partial), then the
    // whole line for legacy returns with no quantity captured.
    const replaceQty = data.quantity != null
      ? Math.floor(Number(data.quantity))
      : (ret.quantity == null ? Number(item?.quantity ?? 1) : Number(ret.quantity));

    if (data.replacementVariantId) {
      // Validate against the shop that actually fulfilled the item, not a
      // platform-wide sum — the replacement ships from the same shop.
      const availability = await this.getReplacementAvailability(user, ret.orderItemId, data.replacementVariantId, replaceQty);
      if (!availability.inStock) {
        throw new BadRequestException('The selected replacement variant is currently out of stock.');
      }
    }

    return await Exchange.create({ returnId, replacementVariantId: data.replacementVariantId, quantity: replaceQty } as any);
  }

  /**
   * Single source of truth for replacement stock.
   *
   * Availability is scoped to (replacement variant × the shop that fulfilled the
   * original item), because the replacement is dispatched from that same shop.
   *
   * Stock semantics: reserving decrements ShopInventory.quantity and writes an
   * InventoryReservation row (see ExchangeApprovedListener), so `quantity` is
   * ALREADY the available figure — reservations must not be subtracted again.
   *   available = ShopInventory.quantity
   *   reserved  = sum of RESERVED InventoryReservation rows (informational)
   *   onHand    = available + reserved (physical stock in the shop)
   */
  async getReplacementAvailability(user: JwtPayload, orderItemId: string, replacementVariantId?: string, requiredQty?: number) {
    const item = await this.orderItemModel.findByPk(orderItemId, {
      include: [{ model: OrderShipment, include: [Order] }],
    });
    if (!item) throw new NotFoundException('Order item not found');

    // Ownership / tenancy scope.
    const ownerId = (item as any).shipment?.order?.userId;
    if (user.role === Role.CUSTOMER && ownerId !== user.sub) {
      throw new ForbiddenException('AUTH_FORBIDDEN');
    }
    if (user.role === Role.SHOP_MANAGER && item.shopId !== user.shopId) {
      throw new ForbiddenException('AUTH_FORBIDDEN');
    }

    // Replacement defaults to the exact variant purchased.
    const variantId = replacementVariantId ?? item.variantId;
    const shopId = item.shopId;
    // Required units default to the whole purchased line; a partial replacement
    // passes the specific quantity it needs.
    const requiredQuantity = requiredQty != null && requiredQty > 0 ? Math.floor(requiredQty) : item.quantity;

    const inv = await this.inventoryModel.findOne({ where: { shopId, variantId, isActive: true } });
    const available = inv ? Number(inv.quantity) : 0;

    const reserved = Number(
      (await InventoryReservation.sum('quantity', {
        where: { shopId, variantId, status: 'RESERVED' },
      })) ?? 0,
    );

    return {
      variantId,
      shopId,
      requiredQuantity,
      available,
      reserved,
      onHand: available + reserved,
      inStock: available >= requiredQuantity,
    };
  }
}
