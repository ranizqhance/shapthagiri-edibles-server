import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { EmailLog } from "@/models";
import { emailProvider } from "@/common/providers/email.provider";

export interface SendAttachment { filename: string; content: Buffer | string; contentType?: string }

export interface TrackedSendResult {
  ok: boolean;
  status: "sent" | "failed" | "stubbed";
  messageId: string | null;
  error: string | null;
  attempts: number;
}

/**
 * Sends email with automatic retry + backoff for transient SMTP/network failures and
 * records every outcome in `email_logs`. This is the single choke-point for report
 * delivery so history, retries and tracking are consistent.
 */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);
  private readonly maxAttempts = 3;

  constructor(@InjectModel(EmailLog) private readonly logs: typeof EmailLog) {}

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * A failure is transient (worth retrying) when it looks like a network/SMTP hiccup
   * rather than a hard rejection (bad address / auth). Retrying a hard rejection just
   * wastes time, so we surface it immediately.
   */
  private isTransient(err: any): boolean {
    const code = String(err?.code ?? "").toUpperCase();
    const transientCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ESOCKET", "EDNS", "ENOTFOUND", "EAI_AGAIN", "EENVELOPE"];
    if (transientCodes.includes(code)) return true;
    const resp = Number(err?.responseCode);
    return resp >= 420 && resp < 500; // SMTP 4xx = try again later
  }

  async sendTracked(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    attachments?: SendAttachment[];
    context?: string;
  }): Promise<TrackedSendResult> {
    const attachmentNames = (opts.attachments ?? []).map((a) => a.filename);
    let lastErr: any = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const info = await emailProvider.sendMail({
          to: opts.to, subject: opts.subject, html: opts.html, text: opts.text, attachments: opts.attachments,
        });
        const status = info.stub ? "stubbed" : "sent";
        await this.record({ ...opts, status, messageId: info.messageId, error: null, attempts: attempt, attachmentNames });
        return { ok: true, status, messageId: info.messageId, error: null, attempts: attempt };
      } catch (e: any) {
        lastErr = e;
        const transient = this.isTransient(e);
        this.logger.warn(`Email to ${opts.to} attempt ${attempt}/${this.maxAttempts} failed (${transient ? "transient" : "permanent"}): ${e?.message}`);
        if (!transient || attempt === this.maxAttempts) break;
        await this.sleep(500 * 2 ** (attempt - 1)); // 500ms, 1s, 2s backoff
      }
    }

    const error = String(lastErr?.message ?? lastErr ?? "Unknown email error");
    await this.record({ ...opts, status: "failed", messageId: null, error, attempts: this.maxAttempts, attachmentNames });
    return { ok: false, status: "failed", messageId: null, error, attempts: this.maxAttempts };
  }

  private async record(o: {
    to: string; subject: string; status: string; messageId: string | null; error: string | null;
    attempts: number; context?: string; attachmentNames: string[];
  }) {
    try {
      await this.logs.create({
        recipient: o.to, subject: o.subject, status: o.status, messageId: o.messageId,
        error: o.error, attempts: o.attempts, context: o.context ?? null, attachments: o.attachmentNames,
      } as any);
    } catch (e: any) {
      this.logger.error(`Failed to write email log: ${e?.message}`);
    }
  }

  /** Paginated delivery history for the admin view. */
  async history(opts: { page?: number; limit?: number; context?: string; status?: string } = {}) {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));
    const where: any = {};
    if (opts.context) where.context = opts.context;
    if (opts.status) where.status = opts.status;
    const { rows, count } = await this.logs.findAndCountAll({
      where, order: [["createdAt", "DESC"]], limit, offset: (page - 1) * limit,
    });
    return { items: rows, meta: { page, limit, totalItems: count, totalPages: Math.ceil(count / limit) } };
  }
}
