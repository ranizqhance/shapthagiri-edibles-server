import { Injectable } from "@nestjs/common";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { Op, QueryTypes } from "sequelize";
import { Order, PaymentRefund, Return, Settlement, DeliveryPayout, OrderItem, OrderShipment, Shop } from "@/models";
import { TaxService } from "./tax.service";
import { brandedReportEmail, printableReportHtml, ReportSummaryItem, ReportTable } from "@/common/utils/report-format.util";

/** A fully-built report: numbers + presentation, format-agnostic. */
export interface BuiltReport {
  type: string;
  subject: string;
  title: string;
  generatedAt: Date;
  periodLabel: string;
  summary: ReportSummaryItem[];
  table: ReportTable;
  /** Branded HTML for the email body. */
  bodyHtml: string;
  /** Printable HTML for the PDF attachment. */
  documentHtml: string;
}

export interface PnlRange { from?: string; to?: string }

export interface PnlResult {
  period: { from: string | null; to: string | null };
  /** Money actually taken from customers (captured, non-cancelled orders). */
  grossRevenue: number;
  /** Gross tax billed on those orders. */
  taxCollected: number;
  /** Tax component returned to customers via refunds. */
  taxRefunded: number;
  /** Single source of truth for "Tax Collected": gross tax − refunded tax. */
  netTax: number;
  deliveryFees: number;
  /** Revenue excluding tax, which is collected on behalf of the government. */
  netRevenue: number;
  refunds: number;
  gatewayCharges: number;
  payouts: number;
  /** Cost of goods sold (Σ qty × variant.costPrice) for the counted orders. */
  cogs: number;
  /** True when at least one variant has a costPrice — else Net Profit is really Contribution Margin. */
  cogsAvailable: boolean;
  netProfit: number;
  orders: number;
}

/**
 * Shared finance reporting.
 *
 * Both the P&L endpoint and the scheduled-report executor need the same numbers,
 * so the calculation lives here once rather than being duplicated.
 */
@Injectable()
export class FinanceReportService {
  constructor(
    @InjectModel(Order) private readonly order: typeof Order,
    @InjectModel(PaymentRefund) private readonly refund: typeof PaymentRefund,
    @InjectModel(Settlement) private readonly settlement: typeof Settlement,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly taxService: TaxService,
  ) {}

  private range(r: PnlRange) {
    const where: any = {};
    if (r.from || r.to) {
      where[Op.and] = [];
      if (r.from) where[Op.and].push({ createdAt: { [Op.gte]: new Date(r.from) } });
      if (r.to) {
        const to = new Date(r.to);
        to.setHours(23, 59, 59, 999);
        where[Op.and].push({ createdAt: { [Op.lte]: to } });
      }
    }
    return where;
  }

  /** SQL date-range fragment on `<alias>."createdAt"` + its bind replacements. */
  private rangeSql(r: PnlRange, alias = "o"): { clause: string; repl: Record<string, any> } {
    const parts: string[] = [];
    const repl: Record<string, any> = {};
    if (r.from) { parts.push(`AND ${alias}."createdAt" >= :from`); repl.from = new Date(r.from); }
    if (r.to) { const to = new Date(r.to); to.setHours(23, 59, 59, 999); parts.push(`AND ${alias}."createdAt" <= :to`); repl.to = to; }
    return { clause: parts.join(" "), repl };
  }

  private async scalar(sql: string, repl: Record<string, any>): Promise<number> {
    const rows = await this.sequelize.query<{ v: number }>(sql, { type: QueryTypes.SELECT, replacements: repl });
    return Number(rows?.[0]?.v) || 0;
  }

  /**
   * Profit & loss.
   *
   * The previous version summed EVERY order (including unpaid and cancelled ones),
   * hardcoded payouts to 0 and subtracted nothing else — so "Net Profit" always
   * equalled "Gross Revenue". This counts only money actually captured and
   * subtracts the real outflows.
   */
  async pnl(r: PnlRange = {}): Promise<PnlResult> {
    // "Captured" money includes orders later (partially) refunded — those still
    // collected cash at checkout. Excluding them would drop their whole revenue
    // while refunds are subtracted separately, understating gross AND profit.
    const CAPTURED_STATES = ["captured", "partial_refunded", "refunded"];
    const revenueWhere: any = {
      paymentStatus: { [Op.in]: CAPTURED_STATES },
      status: { [Op.notIn]: ["cancelled", "failed"] },
      ...this.range(r),
    };

    const [grossRevenue, taxCollected, deliveryFees, orders] = await Promise.all([
      this.order.sum("total", { where: revenueWhere }).then((v) => Number(v) || 0),
      this.order.sum("tax", { where: revenueWhere }).then((v) => Number(v) || 0),
      this.order.sum("deliveryFee", { where: revenueWhere }).then((v) => Number(v) || 0),
      this.order.count({ where: revenueWhere }),
    ]);

    // Returns are the business truth for refunds: PaymentRefund misses COD, whose
    // refunds never touch a gateway.
    const refunds = await Return.sum("refundAmount", {
      where: { status: "refunded", ...this.range(r) } as any,
    }).then((v) => Number(v) || 0);

    // Real outflows already computed at settlement time — reused, not recomputed.
    const gatewayCharges = await this.settlement
      .sum("gatewayCharges", { where: this.range(r) })
      .then((v) => Number(v) || 0);

    // Only settlements/payouts actually DISBURSED are a real cash outflow. Pending
    // or failed delivery payouts are not money that has left the platform.
    const payouts = await DeliveryPayout.sum("amount", {
      where: { status: "paid", ...this.range(r) } as any,
    }).then((v) => Number(v) || 0);

    const { clause, repl } = this.rangeSql(r);

    // Tax component of refunds — so "Tax Collected" can be shown net (single source
    // of truth for both the KPI and the P&L breakdown).
    const taxRefunded = await this.scalar(
      `SELECT COALESCE(SUM(r."refundAmount" * CASE WHEN o.subtotal > 0 THEN o.tax / o.subtotal ELSE 0 END), 0)::float8 AS v
       FROM returns r
       JOIN order_items oi ON oi.id = r."orderItemId"
       JOIN order_shipments s ON s.id = oi."shipmentId"
       JOIN orders o ON o.id = s."orderId"
       WHERE r.status = 'refunded' AND r."refundAmount" IS NOT NULL ${clause}`,
      repl,
    );

    // COGS = Σ (units × variant.costPrice) for the same captured orders that make
    // up gross revenue. Zero until costPrice is populated (then it's real).
    const cogs = await this.scalar(
      `SELECT COALESCE(SUM(oi.quantity * COALESCE(v."costPrice", 0)), 0)::float8 AS v
       FROM order_items oi
       JOIN order_shipments s ON s.id = oi."shipmentId"
       JOIN orders o ON o.id = s."orderId"
       JOIN product_variants v ON v.id = oi."variantId"
       WHERE o."paymentStatus" IN ('captured','partial_refunded','refunded') AND o.status NOT IN ('cancelled','failed') ${clause}`,
      repl,
    );

    const cogsAvailable = (await this.scalar(
      `SELECT (COUNT(*) > 0)::int AS v FROM product_variants WHERE "costPrice" IS NOT NULL AND "costPrice" > 0`,
      {},
    )) > 0;

    const netTax = taxCollected - taxRefunded;
    const netRevenue = grossRevenue - taxCollected;
    // Use NET tax here (not gross): `refunds` already contains the tax portion that
    // was returned to customers, so subtracting gross tax + full refunds would
    // double-count the refunded tax. netTax = gross tax owed to the authority.
    // COGS is subtracted only when cost data exists; otherwise this figure is a
    // contribution margin (labelled as such by the UI via cogsAvailable).
    const netProfit = grossRevenue - netTax - refunds - gatewayCharges - payouts - cogs;

    const round = (n: number) => Number(n.toFixed(2));
    return {
      period: { from: r.from ?? null, to: r.to ?? null },
      grossRevenue: round(grossRevenue),
      taxCollected: round(taxCollected),
      taxRefunded: round(taxRefunded),
      netTax: round(netTax),
      deliveryFees: round(deliveryFees),
      netRevenue: round(netRevenue),
      refunds: round(refunds),
      gatewayCharges: round(gatewayCharges),
      payouts: round(payouts),
      cogs: round(cogs),
      cogsAvailable,
      netProfit: round(netProfit),
      orders,
    };
  }

  private static money(n: number): string {
    return `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  }

  /**
   * Builds a scheduled report into a format-agnostic structure: the numbers plus a
   * summary, a tabular breakdown (for CSV), a branded email body and a printable
   * document (for the PDF). Every value comes from the live DB — nothing hardcoded.
   */
  async buildReport(reportType: string): Promise<BuiltReport> {
    const type = (reportType || "pnl").toLowerCase();
    const money = FinanceReportService.money;
    const generatedAt = new Date();

    if (type === "tax" || type === "gst") {
      const periods = await this.taxService.rollup();
      const totals = periods.reduce(
        (a, p) => ({ collected: a.collected + p.collected, refunded: a.refunded + p.refunded, net: a.net + p.net }),
        { collected: 0, refunded: 0, net: 0 },
      );
      const summary: ReportSummaryItem[] = [
        { label: "Periods", value: String(periods.length) },
        { label: "Tax collected", value: money(totals.collected) },
        { label: "Tax refunded", value: money(totals.refunded) },
        { label: "Net tax owed", value: money(totals.net) },
      ];
      const table: ReportTable = {
        columns: ["Period", "Collected", "Refunded", "Net"],
        rows: periods.map((p) => [p.period, money(p.collected), money(p.refunded), money(p.net)]),
      };
      return this.assemble(type, "GST/VAT Reconciliation", "All recorded periods", generatedAt, summary, table);
    }

    if (type === "settlements") {
      const rows = await this.settlement.findAll({
        limit: 100, order: [["createdAt", "DESC"]],
        include: [{ model: Shop, as: "shop", attributes: ["id", "name"] }],
      });
      const total = rows.reduce((s, x) => s + Number(x.netPayable), 0);
      const summary: ReportSummaryItem[] = [
        { label: "Settlements", value: String(rows.length) },
        { label: "Total net payable", value: money(total) },
      ];
      const table: ReportTable = {
        columns: ["Settlement", "Shop", "Net payable", "Status"],
        rows: rows.map((s) => [s.settlementNumber, (s as any).shop?.name ?? "—", money(Number(s.netPayable)), s.status]),
      };
      return this.assemble(type, "Settlement Statement", "Latest 100 settlements", generatedAt, summary, table);
    }

    const p = await this.pnl();
    const profitLabel = p.cogsAvailable ? "Net profit" : "Contribution margin";
    const summary: ReportSummaryItem[] = [
      { label: "Gross revenue", value: money(p.grossRevenue) },
      { label: "Net revenue", value: money(p.netRevenue) },
      { label: "Net tax", value: money(p.netTax) },
      { label: profitLabel, value: money(p.netProfit) },
      { label: "Orders", value: String(p.orders) },
    ];
    const table: ReportTable = {
      columns: ["Line item", "Amount"],
      rows: [
        ["Gross revenue", money(p.grossRevenue)],
        ["Less: tax collected", `- ${money(p.taxCollected)}`],
        ["Net revenue", money(p.netRevenue)],
        ["Less: refunds", `- ${money(p.refunds)}`],
        ["Less: gateway charges", `- ${money(p.gatewayCharges)}`],
        ["Less: delivery payouts", `- ${money(p.payouts)}`],
        ["Less: COGS", `- ${money(p.cogs)}`],
        [profitLabel, money(p.netProfit)],
        ["Orders", String(p.orders)],
      ],
    };
    const periodLabel = p.period.from || p.period.to ? `${p.period.from ?? "…"} → ${p.period.to ?? "…"}` : "All time";
    return this.assemble("pnl", "Profit & Loss Summary", periodLabel, generatedAt, summary, table);
  }

  private assemble(
    type: string, title: string, periodLabel: string, generatedAt: Date,
    summary: ReportSummaryItem[], table: ReportTable,
  ): BuiltReport {
    const subject = `${title} — ${generatedAt.toDateString()}`;
    return {
      type, subject, title, generatedAt, periodLabel, summary, table,
      bodyHtml: brandedReportEmail({ title, generatedAt, periodLabel, summary }),
      documentHtml: printableReportHtml({ title, generatedAt, periodLabel, summary, table }),
    };
  }

  /** Backward-compatible HTML render (email body) used by the statement endpoint. */
  async render(reportType: string): Promise<{ subject: string; html: string }> {
    const r = await this.buildReport(reportType);
    return { subject: r.subject, html: r.bodyHtml };
  }
}
