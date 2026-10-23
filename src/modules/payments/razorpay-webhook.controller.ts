import { env } from "@/config/env";
import { Body, Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import { ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import { RawBodyRequest } from "@nestjs/common";
import { Request } from "express";
import * as crypto from "crypto";
import { InjectModel } from "@nestjs/sequelize";
import { Logger } from "@nestjs/common";
import { Payment } from "@/models";
import { Public } from "@/common/decorators/public.decorator";
import { PaymentsService } from "./payments.service";

/**
 * Razorpay webhook receiver.
 *
 * The storefront already confirms payments two other ways — the browser posts to
 * /payments/verify after checkout, and a cron sweep reconciles anything stuck.
 * Neither helps the customer who pays and then closes the tab before the
 * redirect lands: their order sits PAYMENT_PENDING until the next sweep. This
 * endpoint closes that window, because Razorpay tells us server-to-server the
 * moment the money is captured.
 *
 * It is `@Public()` by necessity: Razorpay holds no session. The only thing
 * standing between this route and the internet is the HMAC below, so treat the
 * signature check as the authentication it is.
 */
@ApiTags("Payments")
@Controller("webhooks")
export class RazorpayWebhookController {
  private readonly logger = new Logger(RazorpayWebhookController.name);

  constructor(
    @InjectModel(Payment) private pay: typeof Payment,
    private payments: PaymentsService,
  ) {}

  @Public()
  @Post("razorpay")
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async handle(
    @Headers("x-razorpay-signature") signature: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: any,
  ) {
    // Razorpay signs the bytes it sent. Re-serialising the parsed body would
    // reorder keys and change whitespace, so the HMAC must be taken over the
    // raw buffer — hence rawBody: true in main.ts.
    const raw = req.rawBody;
    if (!raw || !this.isSignatureValid(raw, signature)) {
      this.logger.warn("Rejected a Razorpay webhook with a bad or missing signature");
      // 200, deliberately: a 4xx makes Razorpay retry for hours and eventually
      // disable the webhook. An unsigned caller is noise, not a delivery failure.
      return { received: true };
    }

    const event: string = body?.event ?? "";
    const entity = body?.payload?.payment?.entity;

    try {
      if (event === "payment.captured" && entity?.order_id) {
        await this.onCaptured(entity);
      } else if (event === "payment.failed" && entity?.order_id) {
        // Nothing to undo: the order stays PAYMENT_PENDING and the cart stays
        // intact, so the customer can retry or switch to COD.
        this.logger.log(`Razorpay reported payment.failed for order ${entity.order_id}`);
      }
    } catch (e: any) {
      // Swallow and acknowledge. The cron sweep in PaymentsService is the
      // backstop; making Razorpay retry adds nothing and risks the webhook
      // being auto-disabled.
      this.logger.error(`Razorpay webhook handling failed for ${event}: ${e?.message}`);
    }

    return { received: true };
  }

  /** Constant-time HMAC-SHA256 comparison against the shared webhook secret. */
  private isSignatureValid(raw: Buffer, signature?: string): boolean {
    // From the validated config, like every other secret: reading process.env
    // here bypassed the boot-time check that it is set in production.
    const secret = env.PAYMENT_WEBHOOK_SECRET;
    if (!secret || !signature) return false;
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  /**
   * Settle the payment this event refers to.
   *
   * `gatewayReferenceId` holds the Razorpay *order* id we minted at intent time;
   * `entity.id` is the payment id, which is only known once money moves.
   * captureVerifiedPayment() is idempotent, so this racing the browser's own
   * /payments/verify call is harmless — whichever arrives second is a no-op.
   */
  private async onCaptured(entity: any) {
    const payment = await this.pay.findOne({ where: { gatewayReferenceId: entity.order_id } });
    if (!payment) {
      this.logger.warn(`Razorpay captured ${entity.id} but no local payment matches order ${entity.order_id}`);
      return;
    }
    // A signed event proves Razorpay sent it, not that it is for the right
    // money. The amount (paise) and currency must match the payment we
    // created, or an order could be settled by a smaller capture.
    const expectedPaise = Math.round(Number(payment.amount) * 100);
    if (Number(entity.amount) !== expectedPaise || String(entity.currency ?? "").toUpperCase() !== String(env.PAYMENT_CURRENCY).toUpperCase()) {
      this.logger.error(`Razorpay capture ${entity.id} for order ${entity.order_id} does not match payment ${payment.id}: got ${entity.amount} ${entity.currency}, expected ${expectedPaise} ${env.PAYMENT_CURRENCY} — not settled`);
      return;
    }
    if (entity.id && payment.gatewayRef !== entity.id) {
      await payment.update({ gatewayRef: entity.id });
    }
    await this.payments.captureVerifiedPayment(payment);
    this.logger.log(`Razorpay webhook captured payment ${payment.id} for order ${payment.orderId}`);
  }
}
