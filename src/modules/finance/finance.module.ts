import { Body, Controller, Get, Module, Post, Patch, Delete, Param, Query, Headers, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiBearerAuth, ApiTags, PartialType } from "@nestjs/swagger";
import { InjectModel, InjectConnection, SequelizeModule } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import {
  Order, OrderShipment, OrderItem, PaymentRefund, TaxRecord, ScheduledReport,
  Settlement, EarningWallet, LedgerEntry, Setting, AuditLog, User, Payment, ProductVariant, Product, Category,
  DeliveryPayout, Shop, EmailLog
} from "@/models";
import { TaxService } from "./tax.service";
import { FinanceReportService } from "./finance-report.service";
import { ScheduledReportCron } from "./scheduled-report.cron";
import { EmailDeliveryService } from "./email-delivery.service";
import { normalizeRecipients, cronFromSchedule } from "@/common/utils/report-format.util";
import { OrderStatus, PaymentStatus } from "../../common/enums/order-status.enum";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { Role } from "@/common/enums/role.enum";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { ScheduleReportDto } from "@/common/dto/common.dto";
import { ForbiddenException, NotFoundException, BadRequestException } from "@/common/errors/http";
import { NotificationsService } from "@/modules/notifications/notifications.service";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { htmlToPdf } from "@/common/utils/pdf.util";

/*
 * PartialType(), not Partial<>.
 *
 * `Partial<T>` is a TypeScript-only construct: it erases to `Object` at
 * runtime, so Nest sees no DTO class, ValidationPipe skips the body entirely,
 * and `whitelist: true` strips nothing. These routes were accepting arbitrary
 * JSON straight into a model update. `PartialType` from @nestjs/swagger keeps
 * the validation metadata and only makes the fields optional.
 */
export class UpdateScheduleReportDto extends PartialType(ScheduleReportDto) {}

@ApiTags("Finance")
@ApiBearerAuth()
@RequirePermissions('finance.view')
@Controller("finance")
export class FinanceController {
  constructor(
    @InjectModel(Order) private order: typeof Order,
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(OrderItem) private orderItem: typeof OrderItem,
    @InjectModel(PaymentRefund) private refund: typeof PaymentRefund,
    @InjectModel(Payment) private payment: typeof Payment,
    @InjectModel(TaxRecord) private taxRecord: typeof TaxRecord,
    @InjectModel(ScheduledReport) private report: typeof ScheduledReport,
    @InjectModel(Settlement) private settlementModel: typeof Settlement,
    @InjectModel(EarningWallet) private walletModel: typeof EarningWallet,
    @InjectModel(LedgerEntry) private ledgerModel: typeof LedgerEntry,
    @InjectModel(Setting) private settingModel: typeof Setting,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    @InjectModel(User) private userModel: typeof User,
    @InjectConnection() private readonly sequelize: Sequelize,
    private notifications: NotificationsService,
    private readonly taxService: TaxService,
    private readonly reportService: FinanceReportService,
    private readonly reportCron: ScheduledReportCron,
    private readonly emailDelivery: EmailDeliveryService,
  ) {}

  /** Serialize a scheduled report for the UI: adds computed nextRun + valid formats. */
  private serializeReport(r: ScheduledReport) {
    const j = r.toJSON() as any;
    return {
      ...j,
      formats: Array.isArray(j.formats) && j.formats.length ? j.formats : ["pdf"],
      enabled: j.enabled !== false,
      nextRunAt: r.enabled === false ? null : this.reportCron.nextRun(r.cronExpr),
    };
  }

  /** Validate + dedupe recipients, rejecting the request when any address is invalid. */
  private cleanRecipients(input: unknown): string[] {
    const { valid, invalid } = normalizeRecipients(input);
    if (invalid.length) throw new BadRequestException("VALIDATION_FAILED", `Invalid email address(es): ${invalid.join(", ")}`);
    if (!valid.length) throw new BadRequestException("VALIDATION_FAILED", "At least one valid recipient email is required");
    return valid;
  }

  private cleanFormats(input: unknown): string[] {
    const allowed = ["pdf", "csv"];
    const list = Array.isArray(input) ? input.map((f) => String(f).toLowerCase()).filter((f) => allowed.includes(f)) : [];
    return list.length ? Array.from(new Set(list)) : ["pdf"];
  }

  /**
   * Resolve the cron expression: an explicit `cronExpr` (advanced/power users) wins;
   * otherwise it is generated from the business-friendly `schedule`. The result is
   * validated so a malformed expression can never be persisted.
   */
  private resolveCron(b: Partial<ScheduleReportDto>): string {
    let cron = b.cronExpr?.trim();
    if (!cron && b.schedule) {
      try { cron = cronFromSchedule(b.schedule as any); }
      catch (e: any) { throw new BadRequestException("VALIDATION_FAILED", e.message); }
    }
    if (!cron) throw new BadRequestException("VALIDATION_FAILED", "A frequency (or cron expression) is required");
    if (this.reportCron.nextRun(cron) === null) throw new BadRequestException("VALIDATION_FAILED", `Invalid cron expression: ${cron}`);
    return cron;
  }

  private round2(n: number): number { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  private getScopedShopId(user: JwtPayload, queryShopId?: string): string {
    if (user.role === Role.SHOP_MANAGER) {
      if (!user.shopId) throw new ForbiddenException("AUTH_FORBIDDEN", "Shop Manager must be assigned to a shop");
      return user.shopId;
    }
    if (!queryShopId) {
      throw new BadRequestException("VALIDATION_FAILED", "Please provide a shopId query parameter");
    }
    return queryShopId;
  }

  // --- Original PNL for Admin ---
  /** Profit & loss. Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD. */
  @Get("pnl")
  async pnl(@Query("from") from?: string, @Query("to") to?: string) {
    return await this.reportService.pnl({ from, to });
  }

  @Get("tax")
  tax1() { return this.taxRecord.findAll({ order: [["period", "DESC"]] }); }

  /** Live per-period rollup straight from orders — the source the log is built from. */
  @Get("tax/rollup")
  taxRollup(@Query("period") period?: string) {
    return this.taxService.rollup(period);
  }

  /** Recomputes the GST/VAT log. Idempotent; already-remitted periods are preserved. */
  @RequirePermissions('taxes.remit')
  @Post("tax/reconcile")
  async taxReconcile(@CurrentUser() u: JwtPayload, @Body() b: { period?: string }) {
    const res = await this.taxService.reconcile(b?.period);
    await this.auditLogModel.create({
      actorId: u.sub, action: "tax_reconcile", entity: "TaxRecord", entityId: b?.period ?? "all",
      after: { reconciled: res.reconciled, skipped: res.skipped },
    } as any);
    return res;
  }

  /** Marks a tax period filed/remitted. */
  @RequirePermissions('taxes.remit')
  @Post("tax/:id/remit")
  async taxRemit(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: { amount?: number }) {
    const rec = await this.taxService.remit(id, b?.amount);
    await this.auditLogModel.create({
      actorId: u.sub, action: "tax_remit", entity: "TaxRecord", entityId: id,
      after: { period: rec.period, remitted: rec.remitted },
    } as any);
    return rec;
  }

  /**
   * Delivery-partner payouts. This previously returned Settlements, which have no
   * `amount` field — the Wallet page reads `p.amount`/`p.status`, so it was reading
   * undefined. Settlements remain available at /finance/settlements.
   */
  @Get("payouts")
  payouts1() {
    return DeliveryPayout.findAll({ limit: 100, order: [["createdAt", "DESC"]] });
  }

  /**
   * Platform-wide wallet summary computed from AUTHORITATIVE records (full SQL
   * aggregation — never a client-side sum over a capped list). All figures are
   * reconcilable to real rows:
   *   Available Balance = real gateway cash in (captured, non-COD)
   *                       − refunds settled − shop settlements paid − partner payouts paid
   *   Pending Settlement = money owed to shops, not yet paid (earning_wallets:
   *                        pendingEarnings + availableEarnings across all shops)
   *   Payouts (MTD)      = cash disbursed this month, by paidAt & status=paid
   *                        (delivery payouts + shop settlements)
   * Transactions are real records (payments / refunds / settlements / payouts) —
   * no synthesised rows, no failed capture rendered as an inflow.
   */
  @Get("platform-wallet")
  async platformWallet() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    // ---- KPI aggregates (whole table, not a 100-row window) ----
    const [capturedIn, refundsOut, settlementsPaidOut, partnerPaidOut] = await Promise.all([
      // COD is excluded: the courier holds that cash, the platform never received it.
      this.payment.sum("amount", { where: { status: { [Op.in]: ["captured", "refunded"] }, method: { [Op.ne]: "cod" } } }),
      this.refund.sum("amount", { where: { status: "succeeded" } }),
      this.settlementModel.sum("netPayable", { where: { status: "paid" } }),
      DeliveryPayout.sum("amount", { where: { status: "paid" } }),
    ]);
    const availableBalance =
      Number(capturedIn || 0) - Number(refundsOut || 0) - Number(settlementsPaidOut || 0) - Number(partnerPaidOut || 0);

    // Owed to shops, not yet paid — single source of truth: earning_wallets.
    const walletAgg: any = await this.walletModel.findOne({
      attributes: [
        [this.sequelize.fn("COALESCE", this.sequelize.fn("SUM", this.sequelize.col("pendingEarnings")), 0), "pending"],
        [this.sequelize.fn("COALESCE", this.sequelize.fn("SUM", this.sequelize.col("availableEarnings")), 0), "available"],
      ],
      raw: true,
    });
    const pendingSettlement = Number(walletAgg?.pending || 0) + Number(walletAgg?.available || 0);

    // Disbursed this month (by paidAt, only status=paid) — partners + shop settlements.
    const mtdWhere = { status: "paid", paidAt: { [Op.gte]: monthStart, [Op.lt]: nextMonthStart } } as any;
    const [mtdPartner, mtdSettlement] = await Promise.all([
      DeliveryPayout.sum("amount", { where: mtdWhere }),
      this.settlementModel.sum("netPayable", { where: mtdWhere }),
    ]);
    const mtdPayouts = Number(mtdPartner || 0) + Number(mtdSettlement || 0);

    // ---- Recent transaction feed: real records only ----
    const [payments, refunds, settlements, partnerPayouts] = await Promise.all([
      this.payment.findAll({
        where: { status: { [Op.in]: ["captured", "refunded"] } },
        include: [{ model: PaymentRefund, as: "refunds" }, { model: Order, as: "order" }],
        order: [["createdAt", "DESC"]], limit: 50,
      }),
      this.refund.findAll({
        where: { status: "succeeded" },
        include: [{ model: Payment, as: "payment", include: [{ model: Order, as: "order" }] }],
        order: [["createdAt", "DESC"]], limit: 50,
      }),
      this.settlementModel.findAll({ where: { status: "paid" }, order: [["paidAt", "DESC"]], limit: 50 }),
      DeliveryPayout.findAll({ where: { status: "paid" }, order: [["paidAt", "DESC"]], limit: 50 }),
    ]);

    const tx: any[] = [];
    for (const p of payments as any[]) {
      tx.push({
        id: p.id, orderId: p.orderId, category: "settlement", type: "in",
        label: `Order #${p.order?.orderNumber || String(p.orderId).slice(0, 8)} Payment`,
        amount: Number(p.amount), status: p.status, date: p.createdAt, raw: p,
      });
    }
    for (const r of refunds as any[]) {
      tx.push({
        id: r.id, paymentId: r.paymentId, orderId: r.payment?.orderId, category: "refund", type: "out",
        label: `Refund Processed (Order #${r.payment?.order?.orderNumber || String(r.payment?.orderId || "").slice(0, 8)})`,
        amount: Number(r.amount), status: r.status, date: r.createdAt, raw: r,
      });
    }
    for (const s of settlements as any[]) {
      tx.push({
        id: s.id, shopId: s.shopId, category: "payout", type: "out",
        label: `Shop Settlement #${s.settlementNumber}`,
        amount: Number(s.netPayable), status: s.status, date: s.paidAt || s.updatedAt, raw: s,
      });
    }
    for (const d of partnerPayouts as any[]) {
      tx.push({
        id: d.id, category: "payout", type: "out",
        label: `Delivery Partner Payout`,
        amount: Number(d.amount), status: d.status, date: d.paidAt || d.createdAt, raw: d,
      });
    }
    tx.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      availableBalance: this.round2(availableBalance),
      pendingSettlement: this.round2(pendingSettlement),
      mtdPayouts: this.round2(mtdPayouts),
      transactions: tx.slice(0, 50),
    };
  }

  /** Records a delivery payout as paid (the money movement itself is out of band). */
  @RequirePermissions('finance.manageWallet')
  @Post("payouts/:id/pay")
  async payPayout(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: { reference?: string }) {
    const payout = await DeliveryPayout.findByPk(id);
    if (!payout) throw new NotFoundException("NOT_FOUND", "Payout not found");
    if (payout.status === "paid") throw new BadRequestException("CONFLICT", "Payout is already paid");
    await payout.update({ status: "paid", paidAt: new Date() });
    await this.auditLogModel.create({
      actorId: u.sub, action: "payout_paid", entity: "DeliveryPayout", entityId: id,
      after: { amount: payout.amount, reference: b?.reference ?? null },
    } as any);
    return payout;
  }

  @RequirePermissions('finance.export')
  @Post("reports/schedule")
  async report1(@CurrentUser() u: JwtPayload, @Body() b: ScheduleReportDto) {
    const recipients = this.cleanRecipients(b.recipients);
    const formats = this.cleanFormats(b.formats);
    const cronExpr = this.resolveCron(b);
    const created = await this.report.create({
      ownerId: u.sub, reportType: b.reportType, cronExpr,
      recipients, formats, enabled: b.enabled !== false,
    } as any);
    return this.serializeReport(created);
  }

  @Get("reports")
  async listReports() {
    const rows = await this.report.findAll({ order: [["createdAt", "DESC"]], limit: 100 });
    return rows.map((r) => this.serializeReport(r));
  }

  /** Runs a scheduled report immediately (same path the cron uses). */
  @RequirePermissions('finance.export')
  @Post("reports/:id/run")
  async runReport(@Param("id") id: string) {
    const report = await this.report.findByPk(id);
    if (!report) throw new NotFoundException("NOT_FOUND", "Scheduled report not found");
    return await this.reportCron.run(report);
  }

  /** Update a scheduled report in place (type / cron / recipients / formats / enabled). */
  @RequirePermissions('finance.export')
  @Patch("reports/:id")
  async updateReport(@Param("id") id: string, @Body() b: UpdateScheduleReportDto) {
    const report = await this.report.findByPk(id);
    if (!report) throw new NotFoundException("NOT_FOUND", "Scheduled report not found");
    const patch: any = {};
    if (b.reportType !== undefined) patch.reportType = b.reportType;
    // Recompute cron when either the raw expression or the business schedule changes.
    if (b.cronExpr !== undefined || b.schedule !== undefined) patch.cronExpr = this.resolveCron(b);
    if (b.recipients !== undefined) patch.recipients = this.cleanRecipients(b.recipients);
    if (b.formats !== undefined) patch.formats = this.cleanFormats(b.formats);
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    await report.update(patch);
    return this.serializeReport(report);
  }

  /** Delivery history for the schedule email-tracking view (admins only). */
  @RequirePermissions('finance.view')
  @Get("email-logs")
  async emailLogs(@Query("page") page?: string, @Query("limit") limit?: string, @Query("context") context?: string, @Query("status") status?: string) {
    return this.emailDelivery.history({ page: Number(page), limit: Number(limit), context, status });
  }

  /** Delete a scheduled report. */
  @RequirePermissions('finance.export')
  @Delete("reports/:id")
  async deleteReport(@Param("id") id: string) {
    const n = await this.report.destroy({ where: { id } });
    if (!n) throw new NotFoundException("NOT_FOUND", "Scheduled report not found");
    return { deleted: true };
  }

  // --- New Multi-vendor Shop-specific Finance endpoints ---

  @Get("shop-summary")
  async getShopSummary(@CurrentUser() u: JwtPayload, @Query("shopId") qShopId?: string) {
    const shopId = this.getScopedShopId(u, qShopId);

    // Compute order counts for this shop's shipments
    const completedOrders = await this.ship.count({ where: { shopId, status: { [Op.in]: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] as any } } });
    const pendingOrders = await this.ship.count({
      where: {
        shopId,
        status: { [Op.in]: [OrderStatus.PLACED, OrderStatus.CONFIRMED, OrderStatus.PACKED, OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY] as any }
      }
    });
    const cancelledOrders = await this.ship.count({ where: { shopId, status: OrderStatus.CANCELLED as any } });
    const returnedOrders = await this.ship.count({ where: { shopId, status: OrderStatus.RETURNED as any } });

    // Compute revenues
    const shipments = await this.ship.findAll({
      where: { shopId, status: { [Op.in]: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] as any } },
      include: [{ model: OrderItem, as: "items" }]
    });

    let totalRevenue = 0;
    let todayRevenue = 0;
    let weeklyRevenue = 0;
    let monthlyRevenue = 0;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    for (const s of shipments) {
      let shipmentTotal = 0;
      for (const item of s.items ?? []) {
        shipmentTotal += Number(item.price) * item.quantity;
      }
      totalRevenue += shipmentTotal;
      if (s.deliveredAt) {
        const delDate = new Date(s.deliveredAt);
        if (delDate >= startOfToday) todayRevenue += shipmentTotal;
        if (delDate >= startOfWeek) weeklyRevenue += shipmentTotal;
        if (delDate >= startOfMonth) monthlyRevenue += shipmentTotal;
      }
    }

    // Get rates
    const taxRateSetting = await this.settingModel.findOne({ where: { key: "tax.rate" } });
    const gatewayRateSetting = await this.settingModel.findOne({ where: { key: "gateway.fee.rate" } });
    const commissionRateSetting = await this.settingModel.findOne({ where: { key: "platform.commission.rate" } });

    const taxRate = taxRateSetting ? Number(taxRateSetting.value) : 0.18;
    const gatewayRate = gatewayRateSetting ? Number(gatewayRateSetting.value) : 0.02;
    const commissionRate = commissionRateSetting ? Number(commissionRateSetting.value) : 0.05;

    // Derive commission / gateway / tax / net from the SAME window shown beside them in
    // the UI (monthly revenue), so the cards stay internally consistent even when the
    // shop has sales older than the monthly window.
    const platformCommission = monthlyRevenue * commissionRate;
    const gatewayCharges = monthlyRevenue * gatewayRate;
    const taxDeduction = monthlyRevenue * taxRate;
    const netEarnings = monthlyRevenue - platformCommission - gatewayCharges - taxDeduction;

    // Get Wallet
    const [wallet] = await this.walletModel.findOrCreate({
      where: { shopId },
      defaults: { shopId, pendingEarnings: 0, availableEarnings: 0, lockedBalance: 0, paidBalance: 0, upcomingSettlementAmount: 0 } as any
    });

    // Refunded Amount: PaymentRefund -> Payment -> Order -> OrderShipment for this shop
    const refunds = await this.refund.findAll({
      where: { status: "succeeded" },
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
            where: { shopId },
            required: true
          }]
        }]
      }]
    });
    const refundedAmount = refunds.reduce((sum, r) => sum + Number(r.amount), 0);

    return {
      todayRevenue,
      weeklyRevenue,
      monthlyRevenue,
      totalRevenue,
      completedOrders,
      pendingOrders,
      cancelledOrders,
      returnedOrders,
      refundedAmount,
      pendingSettlement: wallet.pendingEarnings,
      availableBalance: wallet.availableEarnings,
      totalPaid: wallet.paidBalance,
      platformCommission,
      gatewayCharges,
      taxDeduction,
      netEarnings
    };
  }

  @Get("shop-analytics")
  async getShopAnalytics(@CurrentUser() u: JwtPayload, @Query("shopId") qShopId?: string) {
    const shopId = this.getScopedShopId(u, qShopId);

    const shipments = await this.ship.findAll({
      where: { shopId, status: { [Op.in]: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] as any } },
      include: [{ model: OrderItem, as: "items" }]
    });

    // Group sales by date
    const dailySales: Record<string, number> = {};
    const dailyOrders: Record<string, number> = {};

    for (const s of shipments) {
      if (!s.deliveredAt) continue;
      const dateStr = new Date(s.deliveredAt).toISOString().slice(0, 10);
      let shipmentTotal = 0;
      for (const item of s.items ?? []) {
        shipmentTotal += Number(item.price) * item.quantity;
      }
      dailySales[dateStr] = (dailySales[dateStr] ?? 0) + shipmentTotal;
      dailyOrders[dateStr] = (dailyOrders[dateStr] ?? 0) + 1;
    }

    // Top Selling Products
    const items = await this.orderItem.findAll({
      where: { shopId },
      include: [{
        model: ProductVariant,
        as: "variant",
        required: true,
        include: [{ model: Product, as: "product", required: true, include: [{ model: Category, as: "category" }] }]
      }]
    });

    const productMap: Record<string, { title: string; qty: number; sales: number }> = {};
    const categoryMap: Record<string, number> = {};

    for (const item of items) {
      const title = item.variant?.product?.title || "Unknown Product";
      const catName = item.variant?.product?.category?.name || "Uncategorized";
      const totalCost = Number(item.price) * item.quantity;

      if (!productMap[title]) {
        productMap[title] = { title, qty: 0, sales: 0 };
      }
      productMap[title].qty += item.quantity;
      productMap[title].sales += totalCost;

      categoryMap[catName] = (categoryMap[catName] ?? 0) + totalCost;
    }

    const topProducts = Object.values(productMap)
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 5);

    const topCategories = Object.entries(categoryMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    return {
      dailySales,
      dailyOrders,
      topProducts,
      topCategories
    };
  }

  @Get("wallet")
  async getWallet(@CurrentUser() u: JwtPayload, @Query("shopId") qShopId?: string) {
    const shopId = this.getScopedShopId(u, qShopId);
    const [wallet] = await this.walletModel.findOrCreate({
      where: { shopId },
      defaults: { shopId, pendingEarnings: 0, availableEarnings: 0, lockedBalance: 0, paidBalance: 0, upcomingSettlementAmount: 0 } as any
    });
    return wallet;
  }

  @Get("ledger")
  async getLedger(
    @CurrentUser() u: JwtPayload,
    @Query("shopId") qShopId?: string,
    @Query("type") type?: string,
    @Query("referenceId") referenceId?: string,
  ) {
    const shopId = this.getScopedShopId(u, qShopId);
    const where: any = { shopId };
    if (type && type !== "all") where.type = type;
    if (referenceId) where.referenceId = { [Op.iLike]: `%${referenceId}%` };

    return this.ledgerModel.findAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: 100
    });
  }

  @Get("settlements")
  async getSettlements(@CurrentUser() u: JwtPayload, @Query("shopId") qShopId?: string) {
    const where: any = {};
    if (u.role === Role.SHOP_MANAGER) {
      where.shopId = this.getScopedShopId(u);
    } else if (qShopId) {
      where.shopId = qShopId;
    }
    return this.settlementModel.findAll({
      where,
      // Multi-shop platform: every settlement carries its originating shop so the
      // Platform Settlements table can label which shop each payout belongs to.
      include: [{ model: Shop, as: "shop", attributes: ["id", "name"] }],
      order: [["createdAt", "DESC"]]
    });
  }

  @Get("settlements/:id")
  async getSettlementDetail(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const settlement = await this.settlementModel.findByPk(id, {
      include: [{ model: Shop, as: "shop", attributes: ["id", "name"] }],
    });
    if (!settlement) throw new NotFoundException("NOT_FOUND", "Settlement not found");

    if (u.role === Role.SHOP_MANAGER && settlement.shopId !== u.shopId) {
      throw new ForbiddenException("AUTH_FORBIDDEN", "You cannot access this settlement detail");
    }

    return settlement;
  }

  private async loadStatementSettlement(u: JwtPayload, id: string): Promise<Settlement> {
    const settlement = await this.settlementModel.findByPk(id, {
      include: [{ model: Shop, as: "shop", attributes: ["id", "name"] }],
    });
    if (!settlement) throw new NotFoundException("NOT_FOUND", "Settlement not found");
    if (u.role === Role.SHOP_MANAGER && settlement.shopId !== u.shopId) {
      throw new ForbiddenException("AUTH_FORBIDDEN", "You cannot access this statement");
    }
    return settlement;
  }

  @RequirePermissions('finance.downloadReports')
  @Get("settlements/:id/statement")
  async getSettlementStatement(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const settlement = await this.loadStatementSettlement(u, id);
    return { content: this.buildStatementHtml(settlement) };
  }

  /** Same statement rendered to a real PDF (streamed binary) for finance archives. */
  @RequirePermissions('finance.downloadReports')
  @Get("settlements/:id/statement.pdf")
  async getSettlementStatementPdf(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Res() res: Response) {
    const settlement = await this.loadStatementSettlement(u, id);
    const html = this.buildStatementHtml(settlement);
    const pdf = await htmlToPdf(html, "settlement-statement", {
      margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="statement-${settlement.settlementNumber}.pdf"`);
    res.end(pdf);
  }

  /*
   * PDF rendering lives in `@/common/utils/pdf.util`. A byte-for-byte copy of
   * it used to sit here as a private method — same launch flags, same missing
   * timeouts — so hardening one left the other untouched.
   */

  private buildStatementHtml(settlement: Settlement): string {
    return `
      <html>
        <head>
          <style>
            body { font-family: sans-serif; padding: 40px; color: ${BRAND.ink}; }
            .header { border-bottom: 3px solid ${BRAND.primary}; padding-bottom: 20px; margin-bottom: 30px; }
            .brand { color: ${BRAND.primary}; font-size: 20px; font-weight: bold; letter-spacing: 3px; font-family: Georgia, 'Times New Roman', serif; }
            .tagline { color: ${BRAND.muted}; font-size: 12px; font-style: italic; margin-bottom: 12px; }
            .title { font-size: 24px; font-weight: bold; color: ${BRAND.primaryDark}; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
            .table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            .th, .td { border: 1px solid ${BRAND.border}; padding: 12px; text-align: left; }
            .th { background-color: ${BRAND.surface}; color: ${BRAND.primaryDark}; font-weight: bold; }
            .total-row { font-weight: bold; background-color: ${BRAND.surface}; }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="brand">${BRAND.wordmark}</div>
            <div class="tagline">${BRAND.legalName} &middot; ${BRAND.tagline}</div>
            <div class="title">Settlement Statement</div>
            <div>Settlement #${settlement.settlementNumber}</div>
            <div>Date: ${new Date(settlement.createdAt).toLocaleDateString()}</div>
          </div>
          <div class="grid">
            <div>
              <strong>Shop:</strong> ${escapeHtml(settlement.shop?.name ?? "—")}<br/>
              <strong>Shop ID:</strong> ${settlement.shopId}<br/>
              <strong>Period:</strong> ${new Date(settlement.startDate).toLocaleDateString()} to ${new Date(settlement.endDate).toLocaleDateString()}<br/>
            </div>
            <div>
              <strong>Status:</strong> ${settlement.status.toUpperCase()}<br/>
              <strong>Paid At:</strong> ${settlement.paidAt ? new Date(settlement.paidAt).toLocaleDateString() : "N/A"}<br/>
            </div>
          </div>
          <table class="table" style="width: 100%;">
            <thead>
              <tr>
                <th class="th">Description</th>
                <th class="th" style="text-align: right;">Amount (INR)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="td">Gross Sales</td>
                <td class="td" style="text-align: right;">+₹${Number(settlement.grossSales).toFixed(2)}</td>
              </tr>
              <tr>
                <td class="td">Discounts Offered</td>
                <td class="td" style="text-align: right;">-₹${Number(settlement.discounts).toFixed(2)}</td>
              </tr>
              <tr>
                <td class="td">Refund Deductions</td>
                <td class="td" style="text-align: right;">-₹${Number(settlement.refundDeductions).toFixed(2)}</td>
              </tr>
              <tr>
                <td class="td">Platform Commission Fee</td>
                <td class="td" style="text-align: right;">-₹${Number(settlement.platformCommission).toFixed(2)}</td>
              </tr>
              <tr>
                <td class="td">Payment Gateway Charges</td>
                <td class="td" style="text-align: right;">-₹${Number(settlement.gatewayCharges).toFixed(2)}</td>
              </tr>
              <tr>
                <td class="td">Tax Deduction (TCS/TDS/GST)</td>
                <td class="td" style="text-align: right;">-₹${Number(settlement.tax).toFixed(2)}</td>
              </tr>
              <tr>
                <td class="td">Adjustments</td>
                <td class="td" style="text-align: right;">₹${Number(settlement.adjustments).toFixed(2)}</td>
              </tr>
              <tr class="total-row">
                <td class="td">Net Payable to Merchant</td>
                <td class="td" style="text-align: right;">₹${Number(settlement.netPayable).toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    `;
  }

  // --- Admin management endpoints ---

  @RequirePermissions('settlement.payout')
  @Post("settlements/:id/pay")
  async paySettlement(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() body: { payoutRef: string }) {
    // Claim the settlement under a row lock: two clicks (or a retried request)
    // must not both see "not paid yet" and debit the shop twice.
    const claimed = await this.sequelize.transaction(async (t) => {
      const row = await this.settlementModel.findByPk(id, { lock: t.LOCK.UPDATE, transaction: t });
      if (!row) throw new NotFoundException("NOT_FOUND", "Settlement not found");
      if (row.status === "paid") throw new BadRequestException("CONFLICT", "Settlement already paid");
      const before = row.status;
      await row.update({ status: "paid", payoutRef: body.payoutRef, paidAt: new Date() }, { transaction: t });
      return { row, before };
    });
    const settlement = claimed.row;
    const previousStatus = claimed.before;

    // Update EarningWallet
    const [wallet] = await this.walletModel.findOrCreate({ where: { shopId: settlement.shopId } });
    const amount = Number(settlement.netPayable);

    await wallet.update({
      availableEarnings: Number(wallet.availableEarnings) - amount,
      upcomingSettlementAmount: Math.max(Number(wallet.upcomingSettlementAmount) - amount, 0),
      paidBalance: Number(wallet.paidBalance) + amount,
      lastSettlementAmount: amount,
      lastSettlementAt: new Date()
    });

    // Create Ledger entry
    await this.ledgerModel.create({
      shopId: settlement.shopId,
      settlementId: settlement.id,
      type: "settlement_debit",
      amount: -amount,
      description: `Settlement payout processed. Payout Ref: ${body.payoutRef}`,
      referenceId: settlement.settlementNumber
    } as any);

    // Create Audit Log
    await this.auditLogModel.create({
      actorId: u.sub,
      action: "pay_settlement",
      entity: "Settlement",
      entityId: settlement.id,
      before: { status: previousStatus },
      after: { status: "paid", payoutRef: body.payoutRef }
    } as any);

    // Notify Manager
    const manager = await this.userModel.findOne({ where: { shopId: settlement.shopId, role: Role.SHOP_MANAGER } });
    if (manager) {
      await this.notifications.notify(
        manager.id,
        "Settlement Paid 💰",
        `Your settlement #${settlement.settlementNumber} of ₹${amount.toFixed(2)} has been successfully paid.`
      );
    }

    return settlement;
  }

  @RequirePermissions('settlement.approve')
  @Post("settlements/:id/schedule")
  async scheduleSettlement(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const settlement = await this.settlementModel.findByPk(id);
    if (!settlement) throw new NotFoundException("NOT_FOUND", "Settlement not found");
    // Scheduling a paid settlement used to reset it to "scheduled", which then
    // let it be paid — and the shop debited — a second time.
    if (settlement.status === "paid") throw new BadRequestException("CONFLICT", "Settlement already paid");
    if (settlement.status === "scheduled") return settlement;

    const previousStatus = settlement.status;
    await settlement.update({ status: "scheduled" });

    // Create Audit Log
    await this.auditLogModel.create({
      actorId: u.sub,
      action: "schedule_settlement",
      entity: "Settlement",
      entityId: settlement.id,
      before: { status: previousStatus },
      after: { status: "scheduled" }
    } as any);

    // Notify Manager
    const manager = await this.userModel.findOne({ where: { shopId: settlement.shopId, role: Role.SHOP_MANAGER } });
    if (manager) {
      await this.notifications.notify(
        manager.id,
        "Settlement Scheduled 📅",
        `Your settlement #${settlement.settlementNumber} of ₹${Number(settlement.netPayable).toFixed(2)} has been scheduled.`
      );
    }

    return settlement;
  }

  @RequirePermissions('settlement.generate')
  @Post("settlements/generate-eligible")
  async generateEligibleSettlements(@CurrentUser() u: JwtPayload) {
    // Find all delivered/completed shipments not yet associated with a settlement
    // Only shipments whose payment has actually been collected: a COD order the
    // courier has not yet handed the cash in for is not earnings yet.
    // REFUNDED shipments were delivered first; their refund is already debited from the
    // shop in real time (FinanceService.handleRefundCompleted), so the sale still settles.
    const shipments = await this.ship.findAll({
      where: {
        status: { [Op.in]: [OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.REFUNDED] as any },
        settlementId: null
      },
      include: [
        { model: OrderItem, as: "items" },
        { model: Order, as: "order", attributes: [], required: true, where: { paymentStatus: { [Op.in]: [PaymentStatus.CAPTURED, PaymentStatus.PARTIAL_REFUNDED] } } },
      ]
    });

    if (shipments.length === 0) {
      return { generated: 0, message: "No eligible shipments found for settlement." };
    }

    // Group shipments by shopId
    const shopShipmentsMap: Record<string, OrderShipment[]> = {};
    for (const s of shipments) {
      if (!shopShipmentsMap[s.shopId]) {
        shopShipmentsMap[s.shopId] = [];
      }
      shopShipmentsMap[s.shopId].push(s);
    }

    // Rates
    const taxRateSetting = await this.settingModel.findOne({ where: { key: "tax.rate" } });
    const gatewayRateSetting = await this.settingModel.findOne({ where: { key: "gateway.fee.rate" } });
    const commissionRateSetting = await this.settingModel.findOne({ where: { key: "platform.commission.rate" } });

    const taxRate = taxRateSetting ? Number(taxRateSetting.value) : 0.18;
    const gatewayRate = gatewayRateSetting ? Number(gatewayRateSetting.value) : 0.02;
    const commissionRate = commissionRateSetting ? Number(commissionRateSetting.value) : 0.05;

    const generatedSettlements: Settlement[] = [];

    for (const [shopId, shopShipments] of Object.entries(shopShipmentsMap)) {
      // One transaction per settlement. A settlement, its shipment links, the
      // wallet movement and the ledger entries must land together or not at all —
      // previously a mid-loop failure left a half-written settlement behind.
      // Per-shop (rather than one giant transaction) so one bad shop cannot void
      // the settlements already computed for the others.
      const settlement = await this.sequelize.transaction(async (t) => {
      let grossSales = 0;
      let minDate = new Date();
      let maxDate = new Date(0);

      for (const s of shopShipments) {
        let shipmentGross = 0;
        for (const item of s.items ?? []) {
          shipmentGross += Number(item.price) * item.quantity;
        }
        grossSales += shipmentGross;

        const date = s.deliveredAt ? new Date(s.deliveredAt) : new Date(s.createdAt);
        if (date < minDate) minDate = date;
        if (date > maxDate) maxDate = date;
      }

      // Refunds are NOT re-deducted here: they are applied to the shop wallet in real
      // time by FinanceService.handleRefundCompleted (which also writes the refund_debit
      // / commission-reversal ledger rows). Deducting them again in the settlement would
      // double-count the refund, so the settlement is purely a sales roll-up.
      const platformCommission = grossSales * commissionRate;
      const gatewayCharges = grossSales * gatewayRate;
      const tax = grossSales * taxRate;
      const netPayable = grossSales - platformCommission - gatewayCharges - tax;

      const settlementNumber = `SET-${Date.now()}-${shopId.slice(0, 4).toUpperCase()}`;

      // Create settlement
      const created = await this.settlementModel.create({
        settlementNumber,
        shopId,
        startDate: minDate,
        endDate: maxDate,
        grossSales,
        discounts: 0,
        refundDeductions: 0,
        platformCommission,
        gatewayCharges,
        tax,
        adjustments: 0,
        netPayable,
        status: "pending",
        details: shopShipments.map((s) => ({ shipmentNumber: s.shipmentNumber, amount: grossSales }))
      } as any, { transaction: t });

      // Link shipments
      for (const s of shopShipments) {
        await s.update({ settlementId: created.id }, { transaction: t });
      }

      // Update EarningWallet
      const [wallet] = await this.walletModel.findOrCreate({ where: { shopId }, transaction: t });
      // Refunds may already have drawn pending below this gross; take the shortfall from
      // available so pending + available still moves by exactly −(gross − net), like the ledger.
      const pendingAfter = Number(wallet.pendingEarnings) - grossSales;
      await wallet.update({
        pendingEarnings: Math.max(pendingAfter, 0),
        availableEarnings: Number(wallet.availableEarnings) + netPayable + Math.min(pendingAfter, 0),
        upcomingSettlementAmount: Number(wallet.upcomingSettlementAmount) + netPayable
      }, { transaction: t });

      // Link the per-delivery order_credit rows (written by EarningWallet.creditOnDelivery)
      // to this settlement instead of writing a second rollup credit — otherwise the
      // gross would be counted twice in the ledger. Backfill any legacy shipments that
      // were delivered before per-delivery crediting existed, so the ledger reconciles:
      // sum(order_credit) − commission − gateway − tax = netPayable.
      const shipmentNumbers = shopShipments.map((s) => s.shipmentNumber);
      const creditEntries = await this.ledgerModel.findAll({
        where: { shopId, type: "order_credit", settlementId: null as any, referenceId: { [Op.in]: shipmentNumbers } },
        transaction: t, lock: t.LOCK.UPDATE,
      });
      if (creditEntries.length) {
        await this.ledgerModel.update(
          { settlementId: created.id },
          { where: { id: { [Op.in]: creditEntries.map((e) => e.id) } }, transaction: t },
        );
      }
      const claimedGross = creditEntries.reduce((sum, e) => sum + Number(e.amount), 0);
      if (grossSales - claimedGross > 0.005) {
        await this.ledgerModel.create({
          shopId,
          orderId: null,
          settlementId: created.id,
          type: "order_credit",
          amount: grossSales - claimedGross,
          description: `Gross sales credit rolled up for settlement ${settlementNumber}`,
          referenceId: settlementNumber
        } as any, { transaction: t });
      }

      await this.ledgerModel.create({
        shopId,
        orderId: null,
        settlementId: created.id,
        type: "commission_debit",
        amount: -platformCommission,
        description: `Platform commission deducted for settlement ${settlementNumber}`,
        referenceId: settlementNumber
      } as any, { transaction: t });

      // Gateway charges as a ledger row so the ledger reconciles to netPayable. Uses the
      // existing `manual_adjustment` enum value (no new enum value / DB migration needed).
      await this.ledgerModel.create({
        shopId,
        orderId: null,
        settlementId: created.id,
        type: "manual_adjustment",
        amount: -gatewayCharges,
        description: `Payment gateway charges deducted for settlement ${settlementNumber}`,
        referenceId: settlementNumber
      } as any, { transaction: t });

      await this.ledgerModel.create({
        shopId,
        orderId: null,
        settlementId: created.id,
        type: "tax_adjustment",
        amount: -tax,
        description: `Tax deduction deducted for settlement ${settlementNumber}`,
        referenceId: settlementNumber
      } as any, { transaction: t });

      // Audit Log
      await this.auditLogModel.create({
        actorId: u.sub,
        action: "generate_settlement",
        entity: "Settlement",
        entityId: created.id,
        before: null,
        after: { settlementNumber, shopId, netPayable }
      } as any, { transaction: t });

      // Notify only once the settlement is actually committed.
      t.afterCommit(async () => {
        const manager = await this.userModel.findOne({ where: { shopId, role: Role.SHOP_MANAGER } });
        if (manager) {
          await this.notifications.notify(
            manager.id,
            "Settlement Generated 💳",
            `A new settlement statement #${settlementNumber} for ₹${netPayable.toFixed(2)} has been generated.`
          ).catch(() => undefined);
        }
      });

      return created;
      });

      generatedSettlements.push(settlement);
    }

    return { generated: generatedSettlements.length, settlements: generatedSettlements };
  }
}



import { FinanceService } from "./finance.service";
import { BRAND } from "@/common/brand";
import { escapeHtml } from "@/common/utils/branded-email.util";

@Module({
  imports: [
    SequelizeModule.forFeature([
      Order, OrderShipment, OrderItem, PaymentRefund, Payment, TaxRecord, ScheduledReport,
      Settlement, EarningWallet, LedgerEntry, Setting, AuditLog, User, ProductVariant, Product, Category,
      DeliveryPayout, Shop, EmailLog
    ]),
    NotificationsModule
  ],
  controllers: [FinanceController],
  providers: [FinanceService, TaxService, FinanceReportService, ScheduledReportCron, EmailDeliveryService],
  exports: [FinanceService, TaxService, FinanceReportService]
})
export class FinanceModule {}
