import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationQueueService } from '@/modules/notifications/notification.queue';
import { NotificationEventType } from '@/common/enums/notification-event.enum';
import { OrdersService } from '@/modules/orders/orders.service';

/**
 * Processor for handling payment captured events.
 * Responsible for executing post-payment workflows like inventory sync,
 * ledger creation, and notifications after synchronous payment verification
 * (which already updated the order/payment status).
 */
@Injectable()
export class PaymentCapturedProcessor {
  private readonly logger = new Logger(PaymentCapturedProcessor.name);

  constructor(
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService: OrdersService,
    @Inject(forwardRef(() => NotificationQueueService))
    private readonly queueService: NotificationQueueService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent('admin.notify')
  async handleAdminNotify(payload: { eventType: NotificationEventType; variables: Record<string, any> }) {
    if (payload.eventType !== NotificationEventType.PAYMENT_CAPTURED) return;
    const orderId = payload.variables?.orderId;
    if (!orderId) {
      this.logger.warn('PAYMENT_CAPTURED event missing orderId');
      return;
    }
    this.logger.log(`Processing PAYMENT_CAPTURED for order ${orderId}`);
    // Execute core business orchestration inside its own transaction.
    await this.ordersService.handleSuccessfulPayment(orderId);
    // Emit a separate notification event after business logic completes.
    this.eventEmitter.emit('admin.notify', {
      eventType: NotificationEventType.PAYMENT_CAPTURED_NOTIFICATION,
      variables: { orderId },
    });
  }
}
