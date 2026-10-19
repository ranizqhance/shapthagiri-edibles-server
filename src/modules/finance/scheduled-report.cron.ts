import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CronTime } from "cron";
import { ScheduledReport } from "@/models";
import { FinanceReportService } from "./finance-report.service";
import { EmailDeliveryService, SendAttachment } from "./email-delivery.service";
import { htmlToPdf } from "@/common/utils/pdf.util";
import { toCsv, normalizeRecipients } from "@/common/utils/report-format.util";

/**
 * Executes scheduled finance reports: renders each due report, builds the requested
 * attachments (PDF/CSV), emails every recipient with retry + delivery tracking, and
 * records the run outcome (success/failed + error) back on the row.
 *
 * Dueness is derived from the row's own cronExpr (parsed with the `cron` library that
 * @nestjs/schedule already ships) rather than a second source of truth.
 */
@Injectable()
export class ScheduledReportCron {
  private readonly logger = new Logger(ScheduledReportCron.name);
  /** In-process guard: a report already running is never started again, so two
   *  overlapping sweeps (or a manual Run during a sweep) can't double-send. */
  private readonly running = new Set<string>();

  constructor(
    @InjectModel(ScheduledReport) private readonly reports: typeof ScheduledReport,
    private readonly reportService: FinanceReportService,
    private readonly email: EmailDeliveryService,
  ) {}

  /** Next fire time implied by a cron expression (null if the expression is invalid). */
  nextRun(cronExpr: string): Date | null {
    try {
      return new CronTime(cronExpr).sendAt().toJSDate();
    } catch {
      return null;
    }
  }

  isDue(cronExpr: string, lastRunAt: Date | null, now = new Date()): boolean {
    if (!lastRunAt) return true;
    try {
      const t = new CronTime(cronExpr);
      const next = t.sendAt().toJSDate();
      const nextAfter = new CronTime(cronExpr).sendAt().toJSDate();
      const intervalMs = Math.max(next.getTime() - now.getTime(), nextAfter.getTime() - next.getTime(), 60_000);
      return now.getTime() - lastRunAt.getTime() >= intervalMs;
    } catch {
      this.logger.warn(`Invalid cronExpr "${cronExpr}" — treating report as not due`);
      return false;
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<{ ran: number; failed: number; skipped: number }> {
    const all = await this.reports.findAll({ limit: 200 });
    let ran = 0, failed = 0, skipped = 0;

    for (const report of all) {
      // Disabled/paused schedules are never swept.
      if (report.enabled === false) { skipped++; continue; }
      if (!this.isDue(report.cronExpr, report.lastRunAt)) { skipped++; continue; }
      try {
        const res = await this.run(report);
        res.ok ? ran++ : failed++;
      } catch (e: any) {
        failed++;
        this.logger.error(`Scheduled report ${report.id} (${report.reportType}) failed: ${e.message}`);
      }
    }

    if (ran || failed) this.logger.log(`Scheduled reports: ${ran} sent, ${failed} failed, ${skipped} not due`);
    return { ran, failed, skipped };
  }

  /**
   * Renders one report and delivers it to all recipients. Exposed so the "Run" action
   * can trigger it on demand. Marks the schedule success only when every recipient was
   * delivered; otherwise failed with the collected errors — after retries are exhausted.
   */
  async run(report: ScheduledReport): Promise<{ ok: boolean; subject: string; recipients: string[]; delivered: number; failed: number }> {
    // Overlap guard — refuse to run the same report concurrently.
    if (this.running.has(report.id)) {
      this.logger.warn(`Report ${report.id} already running — skipping overlapping trigger`);
      return { ok: true, subject: "", recipients: [], delivered: 0, failed: 0 };
    }
    this.running.add(report.id);
    try {
      const built = await this.reportService.buildReport(report.reportType);
      const { valid: recipients } = normalizeRecipients(report.recipients);

      // Build attachments once (shared across recipients) per the schedule's formats.
      const formats = Array.isArray(report.formats) && report.formats.length ? (report.formats as string[]) : ["pdf"];
      const attachments: SendAttachment[] = [];
      const base = `${built.type}-report-${built.generatedAt.toISOString().slice(0, 10)}`;
      if (formats.includes("pdf")) {
        attachments.push({ filename: `${base}.pdf`, content: await htmlToPdf(built.documentHtml), contentType: "application/pdf" });
      }
      if (formats.includes("csv")) {
        attachments.push({ filename: `${base}.csv`, content: toCsv(built.table), contentType: "text/csv" });
      }

      let delivered = 0, failed = 0;
      const errors: string[] = [];
      for (const to of recipients) {
        const r = await this.email.sendTracked({
          to, subject: built.subject, html: built.bodyHtml, attachments, context: `scheduled_report:${report.id}`,
        });
        if (r.ok) delivered++;
        else { failed++; errors.push(`${to}: ${r.error}`); }
      }

      const ok = failed === 0 && recipients.length > 0;
      await report.update({
        lastRunAt: new Date(),
        lastStatus: recipients.length === 0 ? "failed" : ok ? "success" : "failed",
        lastError: recipients.length === 0 ? "No valid recipients" : ok ? null : errors.join(" | ").slice(0, 1000),
      } as any);

      return { ok, subject: built.subject, recipients, delivered, failed };
    } finally {
      this.running.delete(report.id);
    }
  }
}
