import { Injectable, Logger } from "@nestjs/common";
import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException, BadRequestException } from "@/common/errors/http";
import { InjectModel } from "@nestjs/sequelize";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { IdempotencyKey, Invoice, Order, Payment, PaymentRefund, EarningWallet, LedgerEntry, OrderShipment, AuditLog, User, Return, OrderItem, Cart, DeliveryPartner } from "@/models";
import { WILDCARD_PERMISSION } from "@/modules/rbac/rbac.catalog";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Op } from "sequelize";
import { Role } from "@/common/enums/role.enum";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { OrderStatus, PaymentStatus, PaymentMethod } from "@/common/enums/order-status.enum";
import { PaymentIntentDto, PaymentVerifyDto, RefundDto } from "@/common/dto/common.dto";
import { CancelPaymentDto } from "@/common/dto/payment-cancel.dto";
import { env } from "@/config/env";
import { paymentProvider } from "@/common/providers/payment.provider";
import { withIdempotency } from "@/common/utils/idempotency.util";
import { NotificationsService } from "@/modules/notifications/notifications.service";
import { RedisLockService } from "@/common/services/redis-lock.service";
import { OrdersService } from "@/modules/orders/orders.service";
import { NotificationEventType } from "@/common/enums/notification-event.enum";

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel(Payment) private pay: typeof Payment,
    @InjectModel(PaymentRefund) private refund: typeof PaymentRefund,
    @InjectModel(Invoice) private invoice: typeof Invoice,
    @InjectModel(Order) private order: typeof Order,
    @InjectModel(IdempotencyKey) private idem: typeof IdempotencyKey,
    @InjectModel(EarningWallet) private wallet: typeof EarningWallet,
    @InjectModel(LedgerEntry) private ledger: typeof LedgerEntry,
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(Cart) private cart: typeof Cart,
    @InjectModel(DeliveryPartner) private partnerModel: typeof DeliveryPartner,
    private notifications: NotificationsService,
    private lockService: RedisLockService,
    private ordersService: OrdersService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * What the customer still owes the gateway: the stored `payableAmount`, or —
   * for orders placed before that column existed — derived from the gross total
   * minus the stored-value already applied.
   */
  private netPayableOf(order: Order): number {
    const stored = Number(order.payableAmount);
    if (Number.isFinite(stored) && stored > 0) return stored;
    const derived = Number(order.total) - Number(order.giftCardDiscount || 0) - Number(order.walletAmount || 0);
    return Math.max(0, Number(derived.toFixed(2)));
  }

  async createIntent(u: JwtPayload, b: PaymentIntentDto, idemKey?: string) {
    const lockKey = `order:${b.orderId}`;
    const acquired = await this.lockService.acquire(lockKey, 15000);
    if (!acquired) {
      throw new ConflictException('CONFLICT', 'Another request is processing this order');
    }
    try {
      return await withIdempotency(this.idem, { key: idemKey, endpoint: "payments.intent", payload: b }, async () => {
        const order = await this.order.findByPk(b.orderId);
        this.logger.debug(`Intent request: orderId=${order?.id}, orderTotal=${order?.total}`);
        if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");
        if (order.userId !== u.sub && u.role !== Role.ADMIN) throw new ForbiddenException("AUTH_FORBIDDEN");

        // Already settled by stored value (or a completed payment) — never mint
        // another intent for it.
        if (order.paymentStatus === PaymentStatus.CAPTURED) {
          throw new ConflictException("CONFLICT", "This order is already paid");
        }

        // Charge ONLY what is still owed after gift card + wallet. Never
        // order.total (that is the gross and would double-charge), and never a
        // client-supplied amount (tamperable).
        const amount = this.netPayableOf(order);
        if (amount <= 0) {
          throw new ConflictException("CONFLICT", "Nothing left to pay for this order");
        }
        const intent = await paymentProvider.createIntent(order.id, amount);
        this.logger.debug(`Payment intent created: amount=${amount}, clientSecret=${intent.clientSecret}`);
        const p = await this.pay.create({
          orderId: order.id,
          method: b.method,
          gateway: intent.gateway,
          gatewayRef: intent.ref,
          gatewayReferenceId: intent.ref,
          amount,
          status: "pending",
          idempotencyKey: idemKey ?? null,
        } as any);
        return { paymentId: p.id, clientSecret: intent.clientSecret, gateway: intent.gateway, amount, key: intent.gateway === "razorpay" ? env.PAYMENT_KEY_ID : undefined };
      });
    } finally {
      await this.lockService.release(lockKey);
    }
  }

  async retryPayment(orderId: string, u: JwtPayload) {
    const lockKey = `order:${orderId}`;
    const acquired = await this.lockService.acquire(lockKey, 15000);
    if (!acquired) {
      throw new ConflictException('CONFLICT', 'Another request is processing this order');
    }
    try {
      const order = await this.order.findByPk(orderId);
      if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");
      if (order.userId !== u.sub && u.role !== Role.ADMIN) throw new ForbiddenException("AUTH_FORBIDDEN");
      
      // Only an order still waiting for payment. An expired (failed) order has
      // already released its stock, coupon and stored value — taking money for it
      // now would charge for goods that are back on the shelf.
      if (order.status !== OrderStatus.PAYMENT_PENDING) {
        throw new ConflictException("CONFLICT", order.status === OrderStatus.FAILED
          ? "This order expired before it was paid. Please place it again."
          : `Cannot retry payment for order in ${order.status} status`);
      }

      // Re-create payment intent — for the remaining payable only, never the gross total.
      const amount = this.netPayableOf(order);
      if (amount <= 0) {
        throw new ConflictException("CONFLICT", "Nothing left to pay for this order");
      }
      const intent = await paymentProvider.createIntent(order.id, amount);
      this.logger.debug(`Payment retry intent created: amount=${amount}, clientSecret=${intent.clientSecret}`);
      
      const p = await this.pay.create({
        orderId: order.id,
        method: PaymentMethod.CARD, // default for online retries
        gateway: intent.gateway,
        gatewayRef: intent.ref,
        gatewayReferenceId: intent.ref,
        amount,
        status: "pending",
      } as any);

      // We explicitly DO NOT recreate order, inventory hold, or coupons. They are already reserved.

      return { paymentId: p.id, clientSecret: intent.clientSecret, gateway: intent.gateway, amount, key: intent.gateway === "razorpay" ? env.PAYMENT_KEY_ID : undefined };
    } finally {
      await this.lockService.release(lockKey);
    }
  }

  async verifyPayment(b: PaymentVerifyDto) {
    // 1. Verify signature
    if (!paymentProvider.verifyPaymentSignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature)) {
      throw new BadRequestException("BAD_REQUEST", "Invalid payment signature");
    }

    const lockKey = `payment_verify:${b.razorpay_order_id}`;
    const acquired = await this.lockService.acquire(lockKey, 15000);
    if (!acquired) {
      throw new ConflictException('CONFLICT', 'Another request is verifying this payment');
    }

    try {
      // 2. Fetch payment
      const payment = await this.pay.findOne({ where: { gatewayReferenceId: b.razorpay_order_id } });
      if (!payment) throw new NotFoundException("NOT_FOUND", "Payment not found");

      // IMMEDIATELY save the transaction ID (gatewayRef) now that the signature is verified
      if (b.razorpay_payment_id && payment.gatewayRef !== b.razorpay_payment_id) {
        await payment.update({ gatewayRef: b.razorpay_payment_id });
      }

      return await withIdempotency(this.idem, { key: `${payment.id}:verify`, endpoint: "payments.verify", payload: b }, async () => {
        if (payment.status === "captured") {
          return { verified: true, status: "already_captured" };
        }

        // 3. Server-side validation directly with Razorpay API
        const isValid = await paymentProvider.verifyPaymentDetails(
          b.razorpay_payment_id,
          b.razorpay_order_id,
          Number(payment.amount),
          "INR"
        );

        if (!isValid) {
          throw new BadRequestException("BAD_REQUEST", "Payment details validation failed");
        }

        await this.captureVerifiedPayment(payment);
        return { verified: true, status: "captured" };
      });
    } finally {
      await this.lockService.release(lockKey);
    }
  }

  /**
   * Core logic to mark a payment as captured and trigger fulfillment.
   * Assumes verification/signature check or S2S check has already succeeded.
   */
  async captureVerifiedPayment(payment: Payment) {
    if (payment.status === "captured") return;
    
    // Update payment status
    await payment.update({ status: "captured" });
    await this.order.update({ paymentStatus: PaymentStatus.CAPTURED, status: OrderStatus.PAYMENT_SUCCESS }, { where: { id: payment.orderId } });

    // Paid at last, so the cart this order was placed from can be emptied.
    await this.convertCartForPaidOrder(payment.orderId);
    
    // Emit event to trigger post-payment workflows (invoice, inventory sync, etc)
    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.PAYMENT_CAPTURED,
      variables: { orderId: payment.orderId },
    });
  }

  /**
   * Empties (converts) the cart an order was placed from, once that order is paid.
   *
   * Orders paid through a gateway keep their cart alive from placement until
   * here, so a dismissed or failed payment leaves the items intact. Buy Now
   * orders carry no `cartId` and are skipped — their cart may hold unrelated
   * items the customer has not checked out yet.
   *
   * Idempotent: only an `active` cart is converted, so a repeat capture (client
   * verify racing the reconcile sweep) is a no-op the second time.
   */
  private async convertCartForPaidOrder(orderId: string) {
    try {
      const order = await this.order.findByPk(orderId);
      if (!order?.cartId) return;
      await this.cart.update({ status: "converted" }, { where: { id: order.cartId, status: "active" } });
    } catch (e: any) {
      // Never fail a captured payment over cart housekeeping.
      this.logger.error(`Could not convert cart for paid order ${orderId}: ${e?.message}`);
    }
  }

  /**
   * JIT reconciliation for a specific order.
   * Called by read endpoints (returns void, fire-and-forget style) and by the
   * payment-hold timeout queue job (returns `true` when the payment was
   * captured so the caller knows NOT to cancel the order).
   *
   * @returns `true`  – payment was successfully captured during this call
   * @returns `false` – payment was not captured (still pending or error)
   */
  async jitReconcileOrder(orderId: string): Promise<boolean> {
    const payment = await this.pay.findOne({
      where: { orderId, status: "pending" },
      order: [["createdAt", "DESC"]]
    });

    if (!payment || !payment.gatewayReferenceId) return false;

    const lockKey = `payment_verify:${payment.gatewayReferenceId}`;
    const acquired = await this.lockService.acquire(lockKey, 5000);
    if (!acquired) return false; // Another process is already verifying

    try {
      // Re-fetch inside the lock to guard against races
      await payment.reload();
      if (payment.status !== "pending") {
        // Already resolved by a concurrent verification — treat as captured
        return payment.status === "captured";
      }

      const isCaptured = await paymentProvider.isOrderCaptured(payment.gatewayReferenceId);
      if (isCaptured) {
        await this.captureVerifiedPayment(payment);
        return true;
      }
      return false;
    } catch (err) {
      this.logger.error(`JIT Reconciliation failed for order ${orderId}`, err);
      return false;
    } finally {
      await this.lockService.release(lockKey);
    }
  }

  async processRefundImpact(paymentId: string, amount: number, reason: string | null) {
    // DEPRECATED: FinanceService is now the single source of truth for financial updates.
    // This logic has been moved to FinanceService listening to RefundCompleted events.
  }

  /**
   * Record the cash for a cash-on-delivery order. Idempotent: a second click
   * answers `alreadyCollected` instead of writing a second payment. Records
   * what the customer actually owed in cash — the order total less any gift
   * card or wallet applied at checkout.
   *
   * Open to finance (finance.manageWallet), to the fulfilling shop's staff
   * (orders.edit on a shipment of their shop) and to the delivery partner
   * carrying one of its shipments — the person actually handed the cash.
   */
  async confirmCod(id: string, actor: JwtPayload) {
    const order = await this.order.findByPk(id);
    if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");
    await this.assertCanCollectCash(order.id, actor);
    if (order.paymentMethod !== PaymentMethod.COD) {
      throw new ConflictException(undefined, "Only cash-on-delivery orders are confirmed here.");
    }
    if (order.paymentStatus === PaymentStatus.CAPTURED) return { collected: true, alreadyCollected: true };
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.FAILED) {
      throw new ConflictException(undefined, "This order was cancelled — there is no cash to collect.");
    }
    await this.pay.create({
      orderId: id,
      method: "cod",
      gateway: "cod",
      amount: Number(order.payableAmount ?? order.total),
      status: "captured",
    } as any);
    await order.update({ paymentStatus: PaymentStatus.CAPTURED });
    // Coupon redemption, loyalty points and invoice record — what an online
    // capture gets. A failure here must not undo the cash that was collected.
    await this.ordersService.bookCodCollection(order.id).catch((e) =>
      this.logger.error(`COD book-keeping failed for order ${order.id}: ${e?.message}`),
    );
    await this.auditLogModel.create({
      actorId: actor.sub,
      action: "cod_collected",
      entity: "Order",
      entityId: order.id,
      before: { paymentStatus: PaymentStatus.PENDING },
      after: { paymentStatus: PaymentStatus.CAPTURED, amount: Number(order.payableAmount ?? order.total) },
    } as any);
    return { collected: true, alreadyCollected: false };
  }

  private async assertCanCollectCash(orderId: string, u: JwtPayload) {
    const held = new Set(u.permissions ?? []);
    if (held.has(WILDCARD_PERMISSION) || held.has("finance.manageWallet")) return;

    const ships = await this.ship.findAll({ where: { orderId }, attributes: ["shopId", "deliveryPartnerId"] });
    if (held.has("orders.edit") && u.shopId && ships.some((s) => s.shopId === u.shopId)) return;
    if (u.role === Role.DELIVERY_PARTNER) {
      const partner = await this.partnerModel.findOne({ where: { userId: u.sub }, attributes: ["id"] });
      if (partner && ships.some((s) => s.deliveryPartnerId === partner.id)) return;
    }
    throw new ForbiddenException("AUTH_FORBIDDEN");
  }

  async cancelPayment(paymentId: string, u: JwtPayload) {
    const payment = await this.pay.findByPk(paymentId);
    if (!payment) throw new NotFoundException('NOT_FOUND', 'Payment not found');
    if (payment.status !== 'pending') throw new ConflictException(undefined, 'Only pending payments can be cancelled');
    await payment.update({ status: 'cancelled' });
    // revert order payment status to pending
    await this.order.update({ paymentStatus: PaymentStatus.PENDING }, { where: { id: payment.orderId } });
    // Emit cancellation notification
    this.eventEmitter.emit('admin.notify', {
      eventType: NotificationEventType.ORDER_CANCELLED,
      variables: { orderId: payment.orderId },
    });
    // Audit log entry
    await this.auditLogModel.create({
      actorId: u.sub,
      action: 'payment_cancel',
      entity: 'Payment',
      entityId: payment.id,
      before: { status: payment.status },
      after: { status: 'cancelled' },
    } as any);
    return { cancelled: true };
  }

  /**
   * A customer's payments — or, for admin and finance, the recent platform feed.
   *
   * Two things were leaking. `attempts` is the raw gateway payload and
   * `idempotencyKey`/`gatewayReferenceId` are internal correlation handles;
   * none of them are rendered anywhere, and all three went to the browser on
   * every call. And the customer branch had no `limit`, so an account with a
   * long history loaded all of it into memory at once.
   */
  async getMyPayments(u: JwtPayload) {
    const include = [
      { model: PaymentRefund, as: "refunds", attributes: ["id", "amount", "reason", "status", "createdAt"] },
      { model: Order, as: "order", attributes: ["id", "orderNumber", "status", "total", "createdAt"] },
    ];
    const attributes = ["id", "orderId", "method", "gateway", "amount", "status", "createdAt"];

    if (u.role === Role.ADMIN || u.role === Role.FINANCE) {
      return this.pay.findAll({ attributes, include, order: [["createdAt", "DESC"]], limit: 100 });
    }
    const orders = await this.order.findAll({ where: { userId: u.sub }, attributes: ["id"] });
    return this.pay.findAll({
      where: { orderId: orders.map(o => o.id) },
      attributes, include, order: [["createdAt", "DESC"]], limit: 100,
    });
  }

  async refundPayment(b: RefundDto) {
    const payment = await this.pay.findByPk(b.paymentId);
    if (!payment) throw new NotFoundException("NOT_FOUND", "Payment not found");

    /*
     * Never refund more than was taken.
     *
     * `b.amount` came straight from the request body with nothing to compare
     * it against — not the payment, not the refunds already issued. Repeating
     * a full refund, or passing an amount larger than the payment, both
     * succeeded and both moved real money. Permission-gated, so this was a
     * mistake-or-insider problem rather than an anonymous one, but it is the
     * kind of mistake that is expensive and silent.
     */
    if (payment.status !== "captured" && payment.status !== "refunded") {
      throw new BadRequestException("CONFLICT", `Cannot refund a payment with status "${payment.status}".`);
    }
    const alreadyRefunded = (await this.refund.findAll({
      where: { paymentId: payment.id, status: ["succeeded", "processing"] as any },
      attributes: ["amount"],
    })).reduce((sum, r) => sum + Number(r.amount), 0);

    const requested = Number(b.amount);
    const refundable = Number(payment.amount) - alreadyRefunded;
    if (!(requested > 0)) {
      throw new BadRequestException("VALIDATION_FAILED", "Refund amount must be greater than zero.");
    }
    if (requested > refundable + 0.001) {
      throw new BadRequestException(
        "CONFLICT",
        `Refund of ${requested} exceeds the ${refundable.toFixed(2)} still refundable on this payment.`,
      );
    }

    const res = await paymentProvider.refund(payment.gatewayRef ?? payment.id, b.amount);
    const refund = await this.refund.create({
      paymentId: b.paymentId,
      amount: b.amount,
      reason: b.reason ?? null,
      status: res.status,
      refundRef: res.refundRef,
    } as any);
    const fullRefund = alreadyRefunded + requested >= Number(payment.amount) - 0.001;
    await payment.update({ status: "refunded" });
    await this.order.update(
      { paymentStatus: fullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL_REFUNDED },
      { where: { id: payment.orderId } },
    );
    if (res.status === "succeeded" || res.status === "processing") {
      this.eventEmitter.emit("RefundCompleted", {
        paymentId: b.paymentId,
        amount: Number(b.amount),
        transactionId: res.refundRef,
        orderId: payment.orderId
      });
    }
    return refund;
  }

  @OnEvent('RefundRequested')
  async handleRefundRequested(payload: { returnId: string, amount: number, orderId: string, shopId: string }) {
    try {
      const payment = await this.pay.findOne({ where: { orderId: payload.orderId, status: 'captured' } });
      if (!payment) {
        this.logger.error(`No captured payment found for order ${payload.orderId}`);
        return;
      }

      // COD has no gateway leg — cash back is settled out of band, so it stays
      // immediate (unchanged behaviour).
      if (payment.method === 'cod') {
        await this.settleRefund(payment, payload.amount, `cod_refund_${payload.returnId}`, payload.returnId, payload.shopId);
        return;
      }

      const res = await paymentProvider.refund(payment.gatewayRef ?? payment.id, payload.amount);
      const transactionId = res.refundRef || `ref_${Date.now()}`;

      const refundRow = await this.refund.create({
        paymentId: payment.id,
        amount: payload.amount,
        reason: 'Return requested',
        status: res.status,
        refundRef: transactionId
      } as any);

      // Link the refund to its return via the (previously unused) Return.refundId
      // column so the reconciler can resolve the return later without a schema change.
      await Return.update({ refundId: refundRow.id } as any, { where: { id: payload.returnId } });

      if (res.status === 'failed') {
        await this.onRefundFailed(refundRow, payload.returnId);
        return;
      }
      if (res.status !== 'succeeded') {
        // Still in flight at the gateway. Do NOT touch payment/order status and do
        // NOT emit RefundCompleted — the return stays in refund_processing until
        // reconcilePendingRefunds() confirms settlement.
        this.logger.log(`Refund ${transactionId} is ${res.status} at the gateway — awaiting settlement`);
        return;
      }

      await this.settleRefund(payment, payload.amount, transactionId, payload.returnId, payload.shopId);
    } catch (e) {
      this.logger.error('Failed to handle RefundRequested', e);
    }
  }

  /** Applies the money-side effects of a CONFIRMED refund and fans out. */
  private async settleRefund(payment: Payment, amount: number, transactionId: string, returnId: string, shopId: string) {
    const fullRefund = Number(amount) >= Number(payment.amount);
    await payment.update({ status: "refunded" });
    await this.order.update(
      { paymentStatus: fullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL_REFUNDED },
      { where: { id: payment.orderId } },
    );

    this.eventEmitter.emit('RefundCompleted', {
      returnId,
      amount,
      transactionId,
      orderId: payment.orderId,
      shopId,
    });
  }

  private async onRefundFailed(refundRow: PaymentRefund, returnId: string) {
    this.logger.error(`Refund ${refundRow.refundRef} FAILED at the gateway for return ${returnId}`);
    // Deliberately leaves the return in refund_processing — never "refunded".
    await this.notifications.notifyRole(
      Role.FINANCE,
      'Refund failed',
      `Gateway refund ${refundRow.refundRef} failed for return ${returnId}. Manual intervention required.`,
    ).catch(() => undefined);
  }

  /**
   * Backstop sweep for captures that were never reconciled.
   *
   * Captures normally settle via /payments/verify, or via the payment-hold job,
   * or JIT when the customer opens the order. All three are event-driven: if the
   * hold job exhausts its retries (transient gateway error -> DLQ) and the
   * customer never revisits, a payment the gateway actually captured stays
   * "pending" forever — money taken, order never confirmed.
   *
   * This only sweeps payments older than the hold window, so it never races the
   * normal verify flow, and it delegates to jitReconcileOrder (lock + re-check +
   * capture) rather than re-implementing capture. It never cancels anything —
   * cancellation stays owned by the payment-hold job.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcileStuckCaptures(): Promise<{ captured: number; checked: number }> {
    const holdMs = (env.PAYMENT_HOLD_MINUTES ?? 20) * 60_000;
    const olderThan = new Date(Date.now() - holdMs);
    const floor = new Date(Date.now() - 7 * 24 * 3600_000); // don't poll ancient rows forever

    const stale = await this.pay.findAll({
      where: {
        status: 'pending',
        gatewayReferenceId: { [Op.ne]: null as any },
        createdAt: { [Op.lt]: olderThan, [Op.gt]: floor } as any,
      },
      order: [['createdAt', 'DESC']],
      limit: 50,
    });

    let captured = 0;
    for (const p of stale) {
      try {
        if (await this.jitReconcileOrder(p.orderId)) {
          captured++;
          this.logger.warn(`Recovered an unreconciled capture for order ${p.orderId}`);
        }
      } catch (e: any) {
        this.logger.error(`Stuck-capture sweep failed for order ${p.orderId}: ${e.message}`);
      }
    }

    if (captured) this.logger.log(`Stuck-capture sweep: recovered ${captured}/${stale.length}`);
    return { captured, checked: stale.length };
  }

  /**
   * Confirms in-flight refunds by polling the gateway.
   *
   * Razorpay refunds settle asynchronously and this deployment has no working
   * webhook, so polling is the settlement channel — mirroring the existing
   * jitReconcileOrder() approach for captures.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcilePendingRefunds(): Promise<{ settled: number; failed: number; stillPending: number }> {
    const inFlight = await this.refund.findAll({
      where: { status: { [Op.in]: ['pending', 'processing'] } },
      limit: 50,
    });

    let settled = 0, failed = 0, stillPending = 0;

    for (const pr of inFlight) {
      try {
        if (!pr.refundRef) { stillPending++; continue; }

        const status = await paymentProvider.fetchRefundStatus(pr.refundRef);
        if (status === 'processing' || status === 'unknown') { stillPending++; continue; }

        await pr.update({ status });

        const ret = await Return.findOne({ where: { refundId: pr.id } });

        if (status === 'failed') {
          if (ret) await this.onRefundFailed(pr, ret.id);
          failed++;
          continue;
        }

        // Settled for real — now, and only now, mark the money side refunded.
        const payment = await this.pay.findByPk(pr.paymentId);
        if (!payment || !ret) { stillPending++; continue; }
        const item = await OrderItem.findByPk(ret.orderItemId);
        await this.settleRefund(payment, Number(pr.amount), pr.refundRef, ret.id, item?.shopId ?? '');
        settled++;
      } catch (e: any) {
        this.logger.error(`Refund reconciliation failed for ${pr.id}: ${e.message}`);
      }
    }

    if (settled || failed) this.logger.log(`Refund reconciliation: ${settled} settled, ${failed} failed, ${stillPending} pending`);
    return { settled, failed, stillPending };
  }

  async getInvoice(u: JwtPayload, orderId: string) {
    const order = await this.assertInvoiceAccess(u, orderId);
    return this.ordersService.invoice(order.userId, orderId);
  }

  /** The same permission check, returning the bytes for the download route. */
  async getInvoicePdf(u: JwtPayload, orderId: string) {
    const order = await this.assertInvoiceAccess(u, orderId);
    return this.ordersService.invoicePdf(order.userId, orderId);
  }

  /**
   * The customer who placed it, admins, finance — and the manager of a shop
   * that is actually fulfilling it.
   *
   * The shop manager case is new. The fulfilment queue is a manager-facing
   * screen with a "Print Invoice" button on every shipment, so without it that
   * button answers 403 for the exact person whose job it is to put the invoice
   * in the box. Scoped to their own shop by requiring a shipment of this order
   * to belong to it — a manager still cannot read an invoice for an order that
   * never passed through their shop.
   */
  private async assertInvoiceAccess(u: JwtPayload, orderId: string) {
    const order = await this.order.findByPk(orderId);
    if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");

    if (u.role === Role.ADMIN || u.role === Role.FINANCE || order.userId === u.sub) {
      return order;
    }

    if (u.role === Role.SHOP_MANAGER && u.shopId) {
      const fulfilsIt = await this.ship.count({ where: { orderId, shopId: u.shopId } });
      if (fulfilsIt > 0) return order;
    }

    throw new ForbiddenException("AUTH_FORBIDDEN", "You do not have permission to access this invoice");
  }
}
