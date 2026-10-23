import nodemailer, { Transporter } from "nodemailer";
import { env, isProd } from "@/config/env";
import { logger } from "@/common/utils/logger";
import { BRAND } from "@/common/brand";
import { EmailNotConfiguredException, EmailProviderException } from "@/common/errors/integration";

/**
 * Connect, greeting and idle-socket limits for SMTP. nodemailer's defaults are
 * minutes long; a slow or blackholed mail server held each send (and the
 * request or job waiting on it) for that long.
 */
const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 };

export class EmailProvider {
  private transporter: Transporter | null = null;
  /** Logged once, not per send — a warning on every email is just noise. */
  private verified = false;

  private getTransport(): Transporter | null {
    if (this.transporter) return this.transporter;

    // Prefer Gmail app-password credentials (GMAIL_USER / GMAIL_APP_PASSWORD)
    // from the environment when present. `service: "gmail"` sets the correct
    // host/port/TLS automatically.
    if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
      this.transporter = nodemailer.createTransport({
        service: "gmail",
        // Google shows an app password as four space-separated groups
        // ("abcd efgh ijkl mnop") and people paste it exactly as shown. The
        // real secret is the 16 characters without the spaces, so strip them
        // rather than fail a login that looks correct to whoever set it.
        auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD.replace(/\s+/g, "") },
        ...SMTP_TIMEOUTS,
      });
      this.verifyOnce(`gmail, ${env.GMAIL_USER}`);
      return this.transporter;
    }

    // Fall back to generic SMTP credentials.
    if (!env.MAIL_USER || !env.MAIL_PASS) {
      logger.warn("Mail credentials missing — email provider in stub mode");
      return null;
    }
    this.transporter = nodemailer.createTransport({
      host: env.MAIL_HOST,
      port: env.MAIL_PORT,
      secure: env.MAIL_SECURE,
      auth: { user: env.MAIL_USER, pass: env.MAIL_PASS },
      ...SMTP_TIMEOUTS,
    });
    this.verifyOnce(`smtp, ${env.MAIL_HOST}:${env.MAIL_PORT}`);
    return this.transporter;
  }

  /**
   * Prove the credentials work, and say so in the log.
   *
   * Nothing used to check them. An expired Gmail app password produced no
   * signal at all — the first symptom was a customer's password reset throwing,
   * and on a deployment where the variables were simply never set the provider
   * sat in stub mode logging "[Email stub]" while everything above it reported
   * success. One line at startup makes the difference visible.
   *
   * Deliberately not awaited: a slow or unreachable SMTP host must not hold up
   * the send that triggered it, let alone boot.
   */
  private verifyOnce(describe: string): void {
    if (this.verified || !this.transporter) return;
    this.verified = true;
    this.transporter
      .verify()
      .then(() => logger.info(`Email ready (${describe})`))
      .catch((e) =>
        logger.error(
          `Email credentials rejected (${describe}) — mail will fail until this is fixed: ${(e as Error).message}`
        )
      );
  }

  /** True when a send can actually leave this server (not disabled, credentials set). */
  isConfigured(): boolean {
    return env.ENABLE_EMAIL && !!((env.GMAIL_USER && env.GMAIL_APP_PASSWORD) || (env.MAIL_USER && env.MAIL_PASS));
  }

  /**
   * For flows whose whole point is the email — a reset link, a sign-in code.
   *
   * In stub mode a send "succeeds" without leaving the server, so the API told
   * a customer "a code has been sent" when nothing had been. On the test site,
   * with no mail credentials set, that is exactly how password resets failed
   * without a trace. Production refuses instead; development keeps the stub.
   * Callers check this before looking any account up, so the refusal is the
   * same for every address and says nothing about which ones are registered.
   */
  assertDeliverable(): void {
    if (isProd && !this.isConfigured()) {
      logger.error("Email is not configured (set GMAIL_USER + GMAIL_APP_PASSWORD): reset links and email codes cannot be sent");
      throw new EmailNotConfiguredException();
    }
  }

  /**
   * One line at startup: either the SMTP login is checked now (logs "Email
   * ready" or "credentials rejected"), or the log says mail is not set up —
   * instead of finding out from the first customer who never got a reset link.
   */
  checkAtBoot(): void {
    if (this.isConfigured()) {
      this.getTransport();
    } else if (isProd) {
      logger.error("Email is not configured (set GMAIL_USER + GMAIL_APP_PASSWORD): reset links and email codes will be refused");
    }
  }

  // Gmail requires the From address to be the authenticated account.
  private fromAddress(): string {
    if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) return `${BRAND.name} <${env.GMAIL_USER}>`;
    return env.MAIL_FROM;
  }

  async send(to: string, subject: string, html: string, text?: string): Promise<void> {
    await this.sendMail({ to, subject, html, text });
  }

  /**
   * Full-featured send: supports attachments (PDF/CSV report files) and returns the
   * SMTP result so callers can persist a delivery record (messageId / accepted).
   * `stub: true` is returned when no credentials are configured — the caller decides
   * how to record that (we never silently swallow it).
   */
  async sendMail(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>;
  }): Promise<{ messageId: string | null; accepted: string[]; rejected: string[]; stub: boolean }> {
    try {
      // Honoured here rather than only in the notification queue: password
      // resets, OTP codes and finance reports all call this directly, and were
      // sending happily with ENABLE_EMAIL=false.
      if (!env.ENABLE_EMAIL) {
        logger.info(`[Email disabled] → ${opts.to} | ${opts.subject}`);
        return { messageId: null, accepted: [], rejected: [], stub: true };
      }

      const t = this.getTransport();
      if (!t) {
        logger.info(`[Email stub] → ${opts.to} | ${opts.subject}`);
        return { messageId: null, accepted: [], rejected: [], stub: true };
      }
      const info = await t.sendMail({
        from: this.fromAddress(),
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        attachments: opts.attachments,
      });
      logger.info(`Email sent → ${opts.to} (id=${info.messageId})`);
      return {
        messageId: info.messageId ?? null,
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
        stub: false,
      };
    } catch (e) {
      throw new EmailProviderException(e as Error);
    }
  }
}

export const emailProvider = new EmailProvider();
