import crypto from "node:crypto";
import { env } from "@/config/env";
import { logger } from "@/common/utils/logger";
import Razorpay from 'razorpay';

export interface PaymentIntentResult {
  clientSecret: string;
  ref: string;
  gateway: string;
}

/** Mirrors the PaymentRefund.status enum (minus the initial "pending"). */
export type RefundStatus = "succeeded" | "processing" | "failed";
export interface RefundResult {
  refundRef: string;
  status: RefundStatus;
}

/**
 * Razorpay refund lifecycle: pending -> processed | failed.
 * Anything unrecognised is treated as still in flight — never as settled.
 */
export function mapGatewayRefundStatus(gatewayStatus?: string): RefundStatus {
  if (gatewayStatus === "processed") return "succeeded";
  if (gatewayStatus === "failed") return "failed";
  return "processing";
}

/**
 * Gateway-agnostic payment provider.
 *
 * - When `PAYMENT_KEY_SECRET` is empty it runs the built-in **mock** gateway
 *   (same degrade-to-stub pattern as the SMS/email/push providers) so the
 *   platform is fully exercisable in development.
 * - To go live, set `PAYMENT_GATEWAY` + `PAYMENT_KEY_ID` + `PAYMENT_KEY_SECRET`
 *   and implement the gateway call inside `createIntent` / `refund` (the SDK
 *   call is the only thing that changes — the controller flow stays the same).
 * - `verifyPaymentSignature` performs a real HMAC-SHA256 check (Razorpay style)
 *   so the payment verification endpoint is secure.
 */

/**
 * Bound a gateway call in time.
 *
 * The Razorpay SDK has no timeout of its own, so every call here could hang
 * indefinitely — holding an Express worker, and in the capture path holding
 * the per-order Redis lock well past its 15-second TTL. A gateway having a
 * bad minute should fail a request, not accumulate stuck workers until the
 * process stops answering.
 *
 * Note this bounds how long WE wait, not what the gateway did: a timed-out
 * capture may still have succeeded, which is exactly what the reconciliation
 * cron in payments.service.ts is there to settle.
 */
const GATEWAY_TIMEOUT_MS = 15_000;

function withGatewayTimeout<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Payment gateway timed out after ${GATEWAY_TIMEOUT_MS}ms (${label})`)),
      GATEWAY_TIMEOUT_MS,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Rupees to the gateway's integer paise. `145.5 * 100` is 14550.000000000002 in
 * floating point: Razorpay rejects a non-integer amount, and the strict amount
 * check in verifyPaymentDetails could never match it. The webhook already
 * rounds this way.
 */
export const toPaise = (rupees: number | string) => Math.round(Number(rupees) * 100);

export class PaymentProvider {
  get gateway(): string {
    return env.PAYMENT_KEY_SECRET ? env.PAYMENT_GATEWAY : "mock";
  }

  private get isLive(): boolean {
    return !!env.PAYMENT_KEY_SECRET;
  }

  async createIntent(orderId: string, amount: number, currency = env.PAYMENT_CURRENCY): Promise<PaymentIntentResult> {
    if (!this.isLive) {
      logger.info(`[Payment mock] intent for order ${orderId}: ${amount} ${currency}`);
      const ref = `mock_${orderId}_${amount}`;
      return { clientSecret: ref, ref, gateway: "mock" };
    }
    // ── Live Razorpay integration ──────────────────────────────────────
    if (this.gateway === "razorpay") {
      const razorpay = new Razorpay({ key_id: env.PAYMENT_KEY_ID, key_secret: env.PAYMENT_KEY_SECRET });
      const order = await withGatewayTimeout("orders.create", razorpay.orders.create({ amount: toPaise(amount), currency, receipt: orderId }));
      return { clientSecret: order.id, ref: order.id, gateway: "razorpay" };
    }
    throw new Error(`Payment gateway "${env.PAYMENT_GATEWAY}" is configured but no adapter is implemented`);
  }

  async refund(gatewayRef: string, amount: number): Promise<RefundResult> {
    if (!this.isLive) {
      if (gatewayRef && gatewayRef.includes("fail")) {
        throw new Error("Simulated gateway refund failure");
      }
      logger.info(`[Payment mock] refund ${gatewayRef}: ${amount}`);
      return { refundRef: `re_${gatewayRef}_${Date.now()}`, status: "succeeded" };
    }
    if (this.gateway === "razorpay") {
      const razorpay = new Razorpay({ key_id: env.PAYMENT_KEY_ID, key_secret: env.PAYMENT_KEY_SECRET });
      const refundObj = await withGatewayTimeout("payments.refund", razorpay.payments.refund(gatewayRef, { amount: toPaise(amount) }));
      // Razorpay refunds are asynchronous and normally return "pending" here.
      // Reporting "succeeded" unconditionally marked orders refunded before the
      // money had actually moved — report what the gateway really said.
      return { refundRef: refundObj.id, status: mapGatewayRefundStatus(refundObj.status) };
    }
    throw new Error(`Refund for gateway "${env.PAYMENT_GATEWAY}" is not implemented`);
  }

  /**
   * Polls a refund's current state. Webhooks are not wired in this deployment,
   * so settlement is confirmed by polling — the same approach `isOrderCaptured`
   * already uses for captures.
   */
  async fetchRefundStatus(refundRef: string): Promise<RefundStatus | "unknown"> {
    if (!this.isLive) return "succeeded";
    if (this.gateway !== "razorpay") return "unknown";
    try {
      const razorpay = new Razorpay({ key_id: env.PAYMENT_KEY_ID, key_secret: env.PAYMENT_KEY_SECRET });
      const r: any = await withGatewayTimeout("refunds.fetch", razorpay.refunds.fetch(refundRef));
      return mapGatewayRefundStatus(r?.status);
    } catch (e: any) {
      // A transient gateway error must not be read as a settled refund.
      logger.error(`[Payment] fetchRefundStatus(${refundRef}) failed: ${e.message}`);
      return "unknown";
    }
  }

  /**
   * Verify a payment signature from frontend checkout.
   */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!signature || !orderId || !paymentId) return false;
    const body = orderId + "|" + paymentId;
    const expected = crypto.createHmac("sha256", env.PAYMENT_KEY_SECRET || "mock").update(body).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Fetch order payment status directly from the gateway (S2S).
   * Returns true if any payment against this order is fully captured.
   */
  async isOrderCaptured(gatewayRef: string): Promise<boolean> {
    if (!this.isLive) {
      // Mock gateway always treats mock_... refs as captured on verification
      return true;
    }
    if (this.gateway === "razorpay") {
      try {
        const razorpay = new Razorpay({ key_id: env.PAYMENT_KEY_ID, key_secret: env.PAYMENT_KEY_SECRET });
        // Fetch all payments for this order
        const payments = await withGatewayTimeout("orders.fetchPayments", razorpay.orders.fetchPayments(gatewayRef));
        if (payments && payments.items) {
          return payments.items.some((p: any) => p.status === "captured");
        }
        return false;
      } catch (err) {
        logger.error(`[PaymentProvider] Error fetching order status for ${gatewayRef}`, err);
        return false;
      }
    }
    return false;
  }

  /**
   * Verify payment details directly with the gateway (S2S).
   * Validates that the payment exists, belongs to the expected order, matches amount/currency, and is captured.
   */
  async verifyPaymentDetails(
    paymentId: string,
    expectedOrderId: string,
    expectedAmount: number,
    expectedCurrency: string = env.PAYMENT_CURRENCY
  ): Promise<boolean> {
    if (!this.isLive) {
      // Mock gateway accepts everything
      return true;
    }
    if (this.gateway === "razorpay") {
      try {
        const razorpay = new Razorpay({ key_id: env.PAYMENT_KEY_ID, key_secret: env.PAYMENT_KEY_SECRET });
        const payment = await withGatewayTimeout("payments.fetch", razorpay.payments.fetch(paymentId));
        if (!payment) return false;

        if (
          (payment.status === "captured" || payment.status === "authorized") &&
          payment.order_id === expectedOrderId &&
          payment.amount === toPaise(expectedAmount) &&
          payment.currency === expectedCurrency
        ) {
          // If authorized, we can either capture it here or let the backend do it.
          // By returning true, we pass validation. The backend will mark it as captured,
          // but we actually need to hit the Razorpay capture API if it's authorized!
          // We will let the caller know it's valid, but ideally we should capture it.
          // Since the task requires webhook-free, we MUST capture it!
          if (payment.status === "authorized") {
             try {
               await withGatewayTimeout("payments.capture", razorpay.payments.capture(paymentId, toPaise(expectedAmount), expectedCurrency));
               console.log(`[PaymentProvider] Successfully captured authorized payment ${paymentId}`);
             } catch (captureErr) {
               console.error(`[PaymentProvider] Failed to capture authorized payment ${paymentId}`, captureErr);
               return false;
             }
          }
          return true;
        }
        logger.warn(`[PaymentProvider] Validation failed for payment ${paymentId}: status=${payment.status}, order_id=${payment.order_id}, amount=${payment.amount}, currency=${payment.currency}`);
        return false;
      } catch (err) {
        logger.error(`[PaymentProvider] Error fetching payment details for ${paymentId}`, err);
        return false;
      }
    }
    return false;
  }
}

export const paymentProvider = new PaymentProvider();
