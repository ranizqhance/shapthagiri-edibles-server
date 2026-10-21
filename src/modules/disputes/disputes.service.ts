import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { Op } from "sequelize";
import { Dispute, DisputeMessage, Order, User, Payment, PaymentRefund, AuditLog } from "@/models";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { Role } from "@/common/enums/role.enum";
import { BadRequestException, ForbiddenException, NotFoundException, ConflictException } from "@/common/errors/http";
import { NotificationsService } from "@/modules/notifications/notifications.service";
import { WalletService } from "@/modules/wallet/wallet.service";
import { GiftCardService } from "@/modules/promotions/gift-card.service";
import { paymentProvider } from "@/common/providers/payment.provider";
import { paginate } from "@/common/utils/crud.util";

/** Dispute lifecycle. Terminal = resolved | rejected. */
export const DISPUTE_STATUSES = ["open", "under_review", "awaiting_customer", "escalated", "resolved", "rejected"] as const;
const TERMINAL = ["resolved", "rejected"];
// Operations holds disputes.* in RBAC; leaving it out here blocked its whole Disputes page.
const STAFF = [Role.ADMIN, Role.SUPPORT, Role.FINANCE, Role.OPERATIONS];
/** SLA target hours by priority. */
const SLA_HOURS: Record<string, number> = { urgent: 4, high: 12, medium: 24, low: 48 };
/** Monetary resolutions above this, and all gateway/gift-card payouts, need ADMIN/FINANCE. */
const FINANCE_APPROVAL_THRESHOLD = 2000;

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @InjectModel(Dispute) private readonly disputes: typeof Dispute,
    @InjectModel(DisputeMessage) private readonly messages: typeof DisputeMessage,
    @InjectModel(Order) private readonly orders: typeof Order,
    @InjectModel(User) private readonly users: typeof User,
    @InjectModel(Payment) private readonly payments: typeof Payment,
    @InjectModel(PaymentRefund) private readonly refunds: typeof PaymentRefund,
    @InjectModel(AuditLog) private readonly auditLog: typeof AuditLog,
    private readonly notifications: NotificationsService,
    private readonly wallet: WalletService,
    private readonly giftCards: GiftCardService,
  ) {}

  private isStaff(role: string) { return STAFF.includes(role as Role); }

  private slaDueAt(priority: string): Date {
    const hours = SLA_HOURS[priority] ?? SLA_HOURS.medium;
    return new Date(Date.now() + hours * 3_600_000);
  }

  private async audit(actorId: string | null, action: string, disputeId: string, after?: any, t?: any) {
    // actorId is a UUID FK — use null for system/cron actions (not a "system" string).
    await this.auditLog.create({ actorId: actorId ?? null, action, entity: "Dispute", entityId: disputeId, after: after ?? null } as any, { transaction: t });
  }

  private async load(id: string, t?: any): Promise<Dispute> {
    const d = await this.disputes.findByPk(id, { transaction: t, lock: t ? t.LOCK.UPDATE : undefined });
    if (!d) throw new NotFoundException("NOT_FOUND", "Dispute not found");
    return d;
  }

  /** Owner (customer) or any staff may view; mutations are staff-gated by callers. */
  private assertViewAccess(user: JwtPayload, d: Dispute) {
    if (this.isStaff(user.role)) return;
    if (user.role === Role.CUSTOMER && d.customerId === user.sub) return;
    throw new ForbiddenException("AUTH_FORBIDDEN");
  }

  private assertStaff(user: JwtPayload) {
    if (!this.isStaff(user.role)) throw new ForbiddenException("AUTH_FORBIDDEN");
  }

  private assertTransition(d: Dispute, allowedFrom: string[]) {
    if (TERMINAL.includes(d.status)) {
      throw new ConflictException("CONFLICT", `Dispute is already ${d.status} and cannot change.`);
    }
    if (!allowedFrom.includes(d.status)) {
      throw new ConflictException("CONFLICT", `Cannot perform this action while the dispute is "${d.status}".`);
    }
  }

  // ── Phase 1: create / list / get ──────────────────────────────────────────

  async createDispute(user: JwtPayload, dto: any): Promise<Dispute> {
    const order = await this.orders.findByPk(dto.orderId);
    if (!order) throw new NotFoundException("NOT_FOUND", "Order not found");
    // A customer may only dispute their own order; staff may file on behalf.
    if (user.role === Role.CUSTOMER && order.userId !== user.sub) {
      throw new ForbiddenException("AUTH_FORBIDDEN");
    }
    const customerId = user.role === Role.CUSTOMER ? user.sub : order.userId;
    const priority = dto.priority || "medium";

    const dispute = await this.disputes.create({
      orderId: dto.orderId,
      customerId,
      type: dto.type || "other",
      issue: dto.issue,
      priority,
      status: "open",
      desiredResolution: dto.desiredResolution ?? null,
      amountClaimed: dto.amountClaimed ?? null,
      slaDueAt: this.slaDueAt(priority),
    } as any);

    // Attach any evidence the customer uploaded as the opening message.
    if (Array.isArray(dto.attachments) && dto.attachments.length) {
      await this.messages.create({
        disputeId: dispute.id, senderId: user.sub, senderRole: user.role,
        body: "Evidence attached.", attachments: dto.attachments, internal: false,
      } as any);
    }

    await this.audit(user.sub, "Dispute Opened", dispute.id, { type: dispute.type, priority });

    // Notify the queue + acknowledge to the customer.
    await this.notifications.notifyRole(Role.SUPPORT, "New dispute raised", `Order ${order.orderNumber}: ${dto.issue}`);
    await this.notifications.notifyRole(Role.ADMIN, "New dispute raised", `Order ${order.orderNumber}: ${dto.issue}`);
    await this.notifications.notify(customerId, "Dispute received", `We've logged your dispute for order ${order.orderNumber} and our team will review it shortly.`, "all", `/my-disputes`);

    return dispute;
  }

  private buildWhere(opts: any): any {
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.priority) where.priority = opts.priority;
    if (opts.type) where.type = opts.type;
    if (opts.assignedTo) where.assignedTo = opts.assignedTo;
    if (opts.from || opts.to) {
      where.createdAt = {};
      if (opts.from) where.createdAt[Op.gte] = new Date(opts.from);
      if (opts.to) { const to = new Date(opts.to); to.setHours(23, 59, 59, 999); where.createdAt[Op.lte] = to; }
    }
    if (opts.q) {
      const term = `%${String(opts.q).trim()}%`;
      where[Op.or] = [
        { issue: { [Op.iLike]: term } },
        { "$order.orderNumber$": { [Op.iLike]: term } },
        { "$customer.name$": { [Op.iLike]: term } },
        { "$customer.email$": { [Op.iLike]: term } },
      ];
    }
    return where;
  }

  /** Staff queue — server-side filters + pagination. */
  async list(user: JwtPayload, opts: any) {
    this.assertStaff(user);
    return paginate(this.disputes, opts, this.buildWhere(opts), [
      { model: User, as: "customer", attributes: ["id", "name", "email"] },
      { model: User, as: "agent", attributes: ["id", "name", "email"] },
      { model: Order, as: "order", attributes: ["id", "orderNumber", "total", "paymentMethod", "createdAt"] },
    ], { subQuery: false, order: [["createdAt", opts.order || "DESC"]] });
  }

  /** Customer's own disputes. */
  async myDisputes(user: JwtPayload, opts: any) {
    return paginate(this.disputes, opts, { customerId: user.sub }, [
      { model: Order, as: "order", attributes: ["id", "orderNumber", "total", "createdAt"] },
    ], { order: [["createdAt", "DESC"]] });
  }

  async getOne(user: JwtPayload, id: string) {
    const d = await this.disputes.findByPk(id, {
      include: [
        { model: User, as: "customer", attributes: ["id", "name", "email"] },
        { model: User, as: "agent", attributes: ["id", "name", "email"] },
        { model: Order, as: "order", attributes: ["id", "orderNumber", "total", "paymentMethod", "createdAt"] },
      ],
    });
    if (!d) throw new NotFoundException("NOT_FOUND", "Dispute not found");
    this.assertViewAccess(user, d);
    const messages = await this.listMessages(user, d);
    const timeline = await this.auditLog.findAll({
      where: { entity: "Dispute", entityId: id },
      order: [["createdAt", "ASC"]],
      include: [{ model: User, as: "actor", attributes: ["id", "name"] }],
    });
    return { dispute: d, messages, timeline };
  }

  // ── Phase 2: messaging + triage transitions ───────────────────────────────

  private async listMessages(user: JwtPayload, d: Dispute) {
    const where: any = { disputeId: d.id };
    // Customers never see internal staff notes.
    if (!this.isStaff(user.role)) where.internal = false;
    return this.messages.findAll({
      where,
      order: [["createdAt", "ASC"]],
      include: [{ model: User, as: "sender", attributes: ["id", "name", "email"] }],
    });
  }

  async getMessages(user: JwtPayload, id: string) {
    const d = await this.load(id);
    this.assertViewAccess(user, d);
    return this.listMessages(user, d);
  }

  async postMessage(user: JwtPayload, id: string, dto: any) {
    const d = await this.load(id);
    this.assertViewAccess(user, d);
    const staff = this.isStaff(user.role);
    const internal = staff ? !!dto.internal : false; // only staff can mark internal
    const msg = await this.messages.create({
      disputeId: id,
      senderId: user.sub,
      senderRole: user.role,
      body: dto.body,
      attachments: dto.attachments ?? null,
      internal,
    } as any);

    // A customer reply to an info request resumes the review; notify the other side.
    if (!internal) {
      if (!staff && d.status === "awaiting_customer") {
        await d.update({ status: "under_review" });
        await this.audit(user.sub, "Customer Responded", id);
      }
      if (staff && d.customerId !== user.sub) {
        await this.notifications.notify(d.customerId, "New reply on your dispute", "Our team replied to your dispute.", "all", `/my-disputes`);
      } else {
        await this.notifications.notifyRole(Role.SUPPORT, "Customer replied on a dispute", `Dispute ${id.slice(0, 8)} has a new customer message.`);
      }
    }
    return msg;
  }

  async assign(user: JwtPayload, id: string, agentId: string) {
    this.assertStaff(user);
    return this.sequelize.transaction(async (t) => {
      const d = await this.load(id, t);
      this.assertTransition(d, ["open", "under_review", "awaiting_customer", "escalated"]);
      const agent = await this.users.findByPk(agentId, { transaction: t });
      if (!agent || !STAFF.includes(agent.role as Role)) throw new BadRequestException("BAD_REQUEST", "Assignee must be an admin, support, finance or operations user.");
      await d.update({ assignedTo: agentId, status: d.status === "open" ? "under_review" : d.status }, { transaction: t });
      await this.audit(user.sub, "Dispute Assigned", id, { assignedTo: agentId }, t);
      t.afterCommit(async () => {
        await this.notifications.notify(agentId, "Dispute assigned to you", `Dispute ${id.slice(0, 8)} is now yours to handle.`, "all", `/disputes`);
      });
      return { assigned: true };
    });
  }

  async startReview(user: JwtPayload, id: string) {
    this.assertStaff(user);
    return this.sequelize.transaction(async (t) => {
      const d = await this.load(id, t);
      this.assertTransition(d, ["open", "escalated", "awaiting_customer"]);
      await d.update({ status: "under_review", assignedTo: d.assignedTo || user.sub }, { transaction: t });
      await this.audit(user.sub, "Review Started", id, null, t);
      t.afterCommit(async () => {
        await this.notifications.notify(d.customerId, "Your dispute is under review", "A support agent is now reviewing your dispute.", "all", `/my-disputes`);
      });
      return { status: "under_review" };
    });
  }

  async requestInfo(user: JwtPayload, id: string, note?: string) {
    this.assertStaff(user);
    return this.sequelize.transaction(async (t) => {
      const d = await this.load(id, t);
      this.assertTransition(d, ["open", "under_review", "escalated"]);
      await d.update({ status: "awaiting_customer" }, { transaction: t });
      if (note) {
        await this.messages.create({ disputeId: id, senderId: user.sub, senderRole: user.role, body: note, internal: false } as any, { transaction: t });
      }
      await this.audit(user.sub, "Information Requested", id, null, t);
      t.afterCommit(async () => {
        await this.notifications.notify(d.customerId, "More information needed", note || "Please reply with more details so we can resolve your dispute.", "all", `/my-disputes`);
      });
      return { status: "awaiting_customer" };
    });
  }

  async escalate(user: JwtPayload, id: string, reason?: string) {
    this.assertStaff(user);
    return this.sequelize.transaction(async (t) => {
      const d = await this.load(id, t);
      this.assertTransition(d, ["open", "under_review", "awaiting_customer"]);
      await d.update({ status: "escalated" }, { transaction: t });
      await this.audit(user.sub, "Dispute Escalated", id, { reason: reason ?? null }, t);
      t.afterCommit(async () => {
        await this.notifications.notifyRole(Role.ADMIN, "Dispute escalated", `Dispute ${id.slice(0, 8)} needs attention${reason ? `: ${reason}` : ""}.`);
        await this.notifications.notifyRole(Role.FINANCE, "Dispute escalated", `Dispute ${id.slice(0, 8)} needs attention${reason ? `: ${reason}` : ""}.`);
      });
      return { status: "escalated" };
    });
  }

  async reject(user: JwtPayload, id: string, reason: string) {
    this.assertStaff(user);
    return this.sequelize.transaction(async (t) => {
      const d = await this.load(id, t);
      this.assertTransition(d, ["open", "under_review", "awaiting_customer", "escalated"]);
      await d.update({ status: "rejected", closedReason: reason, resolvedBy: user.sub, resolvedAt: new Date(), resolutionType: "none" }, { transaction: t });
      await this.audit(user.sub, "Dispute Rejected", id, { reason }, t);
      t.afterCommit(async () => {
        await this.notifications.notify(d.customerId, "Dispute closed", `After review, we couldn't approve your dispute. Reason: ${reason}`, "all", `/my-disputes`);
      });
      return { status: "rejected" };
    });
  }

  // ── Phase 3: financial resolution ─────────────────────────────────────────

  async resolve(user: JwtPayload, id: string, dto: any) {
    this.assertStaff(user);
    const resType: string = dto.resolutionType;
    const monetary = ["refund_wallet", "refund_source", "gift_card"].includes(resType);
    const amount = monetary ? Number(dto.amount) : 0;

    if (monetary) {
      if (!(amount > 0)) throw new BadRequestException("BAD_REQUEST", "A positive amount is required for a monetary resolution.");
      const needsFinance = amount > FINANCE_APPROVAL_THRESHOLD || resType === "refund_source" || resType === "gift_card";
      if (needsFinance && ![Role.ADMIN, Role.FINANCE].includes(user.role as Role)) {
        throw new ForbiddenException("AUTH_FORBIDDEN", `This resolution requires Admin/Finance approval (amount over ₹${FINANCE_APPROVAL_THRESHOLD} or gateway/gift-card payout).`);
      }
    }

    return this.sequelize.transaction(async (t) => {
      const d = await this.load(id, t);
      this.assertTransition(d, ["open", "under_review", "awaiting_customer", "escalated"]);
      const order = await this.orders.findByPk(d.orderId, { transaction: t });

      // Execute the monetary remedy exactly once (idempotency keyed on the dispute).
      if (resType === "refund_wallet") {
        await this.wallet.credit(d.customerId, amount, {
          type: "refund",
          orderId: d.orderId,
          reason: `Dispute resolution ${id.slice(0, 8)}`,
          idempotencyKey: `dispute-${id}`,
        } as any, t);
      } else if (resType === "gift_card") {
        await this.giftCards.createGiftCard({ initialBalance: amount, customerId: d.customerId, description: `Dispute resolution ${id.slice(0, 8)}` } as any, user.sub);
      } else if (resType === "refund_source") {
        const payment = await this.payments.findOne({ where: { orderId: d.orderId, status: "captured" }, transaction: t });
        if (!payment) throw new BadRequestException("BAD_REQUEST", "No captured online payment to refund to source. Use wallet credit instead.");
        if (amount > Number(payment.amount)) throw new BadRequestException("BAD_REQUEST", "Refund exceeds the captured payment amount.");
        const res = await paymentProvider.refund(payment.gatewayRef ?? payment.id, amount);
        await this.refunds.create({ paymentId: payment.id, amount, reason: `Dispute ${id.slice(0, 8)}`, status: res.status, refundRef: res.refundRef || `disp_${id.slice(0, 8)}` } as any, { transaction: t });
      }
      // replacement / goodwill / none → no money moved here.

      await d.update({
        status: "resolved",
        resolution: dto.resolution,
        resolutionType: resType,
        resolutionAmount: monetary ? amount : null,
        resolvedBy: user.sub,
        resolvedAt: new Date(),
      }, { transaction: t });

      await this.audit(user.sub, "Dispute Resolved", id, { resolutionType: resType, amount: monetary ? amount : 0 }, t);

      t.afterCommit(async () => {
        const money = monetary ? ` A ${resType === "gift_card" ? "gift card" : "refund"} of ₹${amount.toFixed(2)} has been issued.` : "";
        await this.notifications.notify(d.customerId, "Your dispute was resolved", `${dto.resolution}${money}`, "all", `/my-disputes`);
        if (monetary) {
          await this.notifications.notifyRole(Role.FINANCE, "Dispute payout issued", `Dispute ${id.slice(0, 8)}: ${resType} ₹${amount.toFixed(2)} for order ${order?.orderNumber ?? ""}.`);
        }
      });

      return { resolved: true, resolutionType: resType, amount: monetary ? amount : 0 };
    });
  }

  // ── SLA auto-escalation (cron) ────────────────────────────────────────────

  /**
   * Escalate team-owned disputes that have blown their SLA. Only `open` /
   * `under_review` are swept — `awaiting_customer` pauses the clock (the delay is
   * on the customer) and `escalated`/terminal are already past this stage.
   * Idempotent: once escalated a dispute no longer matches.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async autoEscalateOverdue(): Promise<{ escalated: number }> {
    // Do the flip in one DB statement so the timestamptz comparison happens in
    // Postgres (timezone-consistent) and is atomic — no JS Date serialization,
    // no per-row race. RETURNING gives us the rows to audit + notify.
    const [rows]: any = await this.sequelize.query(
      `UPDATE "disputes"
         SET "status" = 'escalated', "updatedAt" = NOW()
       WHERE "status" IN ('open', 'under_review')
         AND "slaDueAt" IS NOT NULL
         AND "slaDueAt" < NOW()
       RETURNING "id", "customerId"`,
    );
    const escalated = Array.isArray(rows) ? rows : [];
    for (const r of escalated) {
      try {
        await this.audit(null, "SLA Breach — Auto-escalated", r.id);
        await this.notifications.notifyRole(Role.ADMIN, "Dispute SLA breached", `Dispute ${String(r.id).slice(0, 8)} exceeded its SLA and was auto-escalated.`);
        await this.notifications.notifyRole(Role.FINANCE, "Dispute SLA breached", `Dispute ${String(r.id).slice(0, 8)} exceeded its SLA and was auto-escalated.`);
      } catch (e) {
        this.logger.error(`Post-escalation notify/audit failed for dispute ${r.id}: ${(e as Error).message}`);
      }
    }
    if (escalated.length) this.logger.log(`SLA sweep auto-escalated ${escalated.length} dispute(s).`);
    return { escalated: escalated.length };
  }

  // ── Payment-gateway chargeback ingestion ──────────────────────────────────

  /**
   * Map an inbound gateway chargeback to a Dispute. This is the handler a gateway
   * webhook (e.g. Razorpay `payment.dispute.created`) calls; it can also be
   * invoked by Finance manually. Idempotent on `externalRef` (the gateway dispute
   * id) so a re-delivered webhook never creates a duplicate. A chargeback is a
   * formal, money-at-risk gateway dispute, so it lands as `escalated`/`urgent`
   * and pings Finance immediately.
   */
  async ingestChargeback(actorId: string, dto: { orderId?: string; paymentRef?: string; externalRef: string; amount: number; reason?: string }): Promise<Dispute> {
    const existing = await this.disputes.findOne({ where: { externalRef: dto.externalRef } });
    if (existing) return existing; // idempotent

    // Resolve the order: directly, or via the payment gateway ref.
    let order: Order | null = null;
    if (dto.orderId) order = await this.orders.findByPk(dto.orderId);
    if (!order && dto.paymentRef) {
      const payment = await this.payments.findOne({ where: { gatewayRef: dto.paymentRef } });
      if (payment) order = await this.orders.findByPk(payment.orderId);
    }
    if (!order) throw new NotFoundException("NOT_FOUND", "Could not resolve an order for this chargeback.");

    const dispute = await this.disputes.create({
      orderId: order.id,
      customerId: order.userId,
      type: "billing",
      source: "chargeback",
      externalRef: dto.externalRef,
      issue: `Payment gateway chargeback${dto.reason ? `: ${dto.reason}` : ""}`,
      priority: "urgent",
      status: "escalated",
      amountClaimed: dto.amount,
      slaDueAt: this.slaDueAt("urgent"),
    } as any);

    await this.audit(actorId, "Chargeback Ingested", dispute.id, { externalRef: dto.externalRef, amount: dto.amount });
    await this.notifications.notifyRole(Role.FINANCE, "Chargeback received", `Gateway chargeback ₹${Number(dto.amount).toFixed(2)} on order ${order.orderNumber} — action required.`);
    await this.notifications.notifyRole(Role.ADMIN, "Chargeback received", `Gateway chargeback ₹${Number(dto.amount).toFixed(2)} on order ${order.orderNumber}.`);
    return dispute;
  }
}
