import { Injectable, Logger } from "@nestjs/common";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { Cron, CronExpression } from "@nestjs/schedule";
import { QueryTypes } from "sequelize";
import { TaxRecord } from "@/models";
import { NotFoundException, BadRequestException } from "@/common/errors/http";

export interface TaxPeriodRollup {
  period: string;
  collected: number;
  refunded: number;
  net: number;
  orders: number;
}

/**
 * GST/VAT reconciliation.
 *
 * `tax_records` existed but nothing ever wrote to it, so the reconciliation log
 * and the "Tax Collected" KPI were structurally stuck at zero. This service is the
 * writer: it rolls tax up per calendar period from the orders that actually took
 * money, nets off tax returned to customers via refunds, and upserts one row per
 * period so re-running is safe.
 *
 * Only 'captured', non-cancelled orders count — an unpaid or cancelled order never
 * collected any tax.
 */
@Injectable()
export class TaxService {
  private readonly logger = new Logger(TaxService.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @InjectModel(TaxRecord) private readonly taxRecord: typeof TaxRecord,
  ) {}

  /** Tax actually collected per period, net of tax refunded on returns. */
  async rollup(period?: string): Promise<TaxPeriodRollup[]> {
    const rows = await this.sequelize.query<any>(
      `
      WITH collected AS (
        SELECT to_char(COALESCE(o."placedAt", o."createdAt"), 'YYYY-MM') AS period,
               COALESCE(SUM(o.tax), 0)  AS collected,
               COUNT(*)                 AS orders
        FROM orders o
        WHERE o."paymentStatus" IN ('captured', 'partial_refunded', 'refunded')
          AND o.status NOT IN ('cancelled', 'failed')
          AND o."deletedAt" IS NULL
        GROUP BY 1
      ),
      refunded AS (
        -- Tax component of refunds, apportioned at the order's own effective tax rate.
        SELECT to_char(COALESCE(o."placedAt", o."createdAt"), 'YYYY-MM') AS period,
               COALESCE(SUM(
                 r."refundAmount" * CASE WHEN o.subtotal > 0 THEN o.tax / o.subtotal ELSE 0 END
               ), 0) AS refunded
        FROM returns r
        JOIN order_items oi   ON oi.id = r."orderItemId"
        JOIN order_shipments s ON s.id = oi."shipmentId"
        JOIN orders o          ON o.id = s."orderId"
        WHERE r.status = 'refunded'
          AND r."refundAmount" IS NOT NULL
        GROUP BY 1
      )
      SELECT c.period,
             c.collected::float8              AS collected,
             COALESCE(rf.refunded, 0)::float8 AS refunded,
             c.orders::int                    AS orders
      FROM collected c
      LEFT JOIN refunded rf ON rf.period = c.period
      ${period ? `WHERE c.period = :period` : ``}
      ORDER BY c.period DESC
      `,
      { type: QueryTypes.SELECT, replacements: period ? { period } : {} },
    );

    return rows.map((r) => {
      const collected = Number(r.collected) || 0;
      const refunded = Number(r.refunded) || 0;
      return {
        period: r.period,
        collected,
        refunded,
        net: Number((collected - refunded).toFixed(2)),
        orders: Number(r.orders) || 0,
      };
    });
  }

  /**
   * Upserts a TaxRecord per period. Idempotent — safe to run repeatedly.
   * Periods already marked `remitted` are left alone: a filed return must not be
   * silently rewritten by a later sweep.
   */
  async reconcile(period?: string): Promise<{ reconciled: number; skipped: number; periods: TaxPeriodRollup[] }> {
    const rollups = await this.rollup(period);
    let reconciled = 0;
    let skipped = 0;

    for (const r of rollups) {
      const [record, created] = await this.taxRecord.findOrCreate({
        where: { period: r.period },
        defaults: { period: r.period, collected: r.net, remitted: 0, status: "pending" } as any,
      });

      if (created) {
        reconciled++;
        continue;
      }

      if (record.status === "remitted") {
        skipped++;
        continue;
      }

      await record.update({ collected: r.net });
      reconciled++;
    }

    if (reconciled || skipped) {
      this.logger.log(`Tax reconciliation: ${reconciled} period(s) updated, ${skipped} already remitted`);
    }
    return { reconciled, skipped, periods: rollups };
  }

  /** Marks a period filed. `remitted` defaults to whatever was collected. */
  async remit(id: string, amount?: number): Promise<TaxRecord> {
    const record = await this.taxRecord.findByPk(id);
    if (!record) throw new NotFoundException("NOT_FOUND", "Tax period not found");
    if (record.status === "remitted") {
      throw new BadRequestException("CONFLICT", `Period ${record.period} is already remitted`);
    }

    const remitted = amount != null ? Number(amount) : Number(record.collected);
    if (!(remitted >= 0)) throw new BadRequestException("VALIDATION_FAILED", "Remitted amount must be >= 0");

    await record.update({ remitted, status: "remitted" });
    this.logger.log(`Tax period ${record.period} remitted: ${remitted}`);
    return record;
  }

  /** Keeps the log current without anyone pressing a button. */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async dailyReconcile() {
    try {
      await this.reconcile();
    } catch (e: any) {
      this.logger.error(`Scheduled tax reconciliation failed: ${e.message}`);
    }
  }
}
