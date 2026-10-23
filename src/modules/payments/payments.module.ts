import { Throttle } from "@nestjs/throttler";
import { LIMITS } from "@/common/security/throttle";
import { Body, Controller, Get, Headers, Param, Post, UseGuards, Module, forwardRef, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { SequelizeModule } from "@nestjs/sequelize";
import { IdempotencyKey, Invoice, Order, Payment, PaymentRefund, EarningWallet, LedgerEntry, OrderShipment, AuditLog, User, Cart, DeliveryPartner } from "@/models";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { ParseUUIDPipe } from '@nestjs/common';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { PaymentIntentDto, PaymentVerifyDto, RefundDto } from "@/common/dto/common.dto";
import { CancelPaymentDto } from "@/common/dto/payment-cancel.dto";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { RedisLockService } from "@/common/services/redis-lock.service";
import { OrdersModule } from "@/modules/orders/orders.module";
import { PaymentCapturedProcessor } from "./payment-captured.processor";
import { PaymentsService } from "./payments.service";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { ScheduleModule } from "@nestjs/schedule";

@ApiTags("Payments")
// NOTE: mixed customer + staff controller. No class-level permission — customer
// payment flows (intent/verify/retry/me/invoices) must stay reachable by any
// authenticated user. Only the staff money-movement handlers below are gated.
@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /** Create payment intent – idempotent */
  @ApiBearerAuth()
  @Post("intent")
  async intent(
    @CurrentUser() u: JwtPayload,
    @Body() b: PaymentIntentDto,
    @Headers("idempotency-key") idemKey?: string,
  ) {
    return this.paymentsService.createIntent(u, b, idemKey);
  }

  /** Synchronous payment verification from frontend */
  @ApiBearerAuth()
  @Post("verify")
  async verify(
    @CurrentUser() u: JwtPayload,
    @Body() b: PaymentVerifyDto
  ) {
    return this.paymentsService.verifyPayment(b, u);
  }

  @ApiBearerAuth()
  @Post(":orderId/retry")
  async retryPayment(
    @CurrentUser() u: JwtPayload,
    @Param("orderId") orderId: string
  ) {
    return this.paymentsService.retryPayment(orderId, u);
  }

  /**
   * Record the cash for a cash-on-delivery order. Not permission-gated at the
   * route: the delivery partner carrying it and the fulfilling shop's staff
   * hold no finance rights, so the service scopes by the caller instead.
   */
  @ApiBearerAuth()
  @Post("cod/confirm/:orderId")
  async cod(@CurrentUser() u: JwtPayload, @Param("orderId", ParseUUIDPipe) id: string) {
    return this.paymentsService.confirmCod(id, u);
  }

  /** Cancel a pending payment */
  @ApiBearerAuth()
  @RequirePermissions('finance.manageWallet')
  @Post('cancel/:paymentId')
  async cancel(@Param('paymentId', ParseUUIDPipe) paymentId: string, @Body() dto: CancelPaymentDto, @CurrentUser() u: JwtPayload) {
    return this.paymentsService.cancelPayment(paymentId, u);
  }

  @ApiBearerAuth()
  @Get("me")
  async me(@CurrentUser() u: JwtPayload) {
    return this.paymentsService.getMyPayments(u);
  }

  @ApiBearerAuth()
  @RequirePermissions('finance.manageWallet')
  @Post("refunds")
  async refundIt(@Body() b: RefundDto) {
    return this.paymentsService.refundPayment(b);
  }

  @ApiBearerAuth()
  @Get("invoices/:orderId")
  async inv(@CurrentUser() u: JwtPayload, @Param("orderId") orderId: string) {
    return this.paymentsService.getInvoice(u, orderId);
  }

  /**
   * The invoice PDF itself.
   *
   * Streamed from here rather than handed out as the stored S3 link: that
   * object lives under the bucket's `general/` prefix, which is deliberately
   * not world-readable because an invoice carries the customer's name, address
   * and phone. The browser was fetching that link directly and getting a 403,
   * which surfaced as "Something went wrong".
   */
  @Throttle(LIMITS.export)
  @ApiBearerAuth()
  @Get("invoices/:orderId/pdf")
  async invPdf(
    @CurrentUser() u: JwtPayload,
    @Param("orderId") orderId: string,
    @Res() res: Response,
  ) {
    const { filename, pdf } = await this.paymentsService.getInvoicePdf(u, orderId);
    res.set({
      "Content-Type": "application/pdf",
      // `inline` so a browser can preview it; the filename is still offered to
      // whatever the customer chooses to save it as.
      "Content-Disposition": `inline; filename="${filename}"`,
      "Content-Length": String(pdf.length),
      // Contains personal data — never let a shared cache keep a copy.
      "Cache-Control": "private, no-store",
    });
    res.end(pdf);
  }
}

@Module({
  imports: [
    SequelizeModule.forFeature([
      Payment,
      PaymentRefund,
      Invoice,
      Order,
      IdempotencyKey,
      EarningWallet,
      LedgerEntry,
      OrderShipment,
      AuditLog,
      User,
      // Carts are converted here, on capture, not at placement.
      Cart,
      // Who may record cash on delivery (the partner carrying the order).
      DeliveryPartner,
    ]),
    forwardRef(() => NotificationsModule),
    forwardRef(() => OrdersModule),
  ],
  controllers: [PaymentsController, RazorpayWebhookController],
  providers: [RedisLockService, PaymentsService, PaymentCapturedProcessor],
  exports: [PaymentsService],
})
export class PaymentsModule {}
