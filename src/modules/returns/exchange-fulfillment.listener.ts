import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ExchangeFulfillmentService } from './exchange-fulfillment.service';

@Injectable()
export class ExchangeFulfillmentListener {
  private readonly logger = new Logger(ExchangeFulfillmentListener.name);

  constructor(private readonly fulfillmentService: ExchangeFulfillmentService) {}

  @OnEvent('exchange.qc_passed', { async: true })
  async handleQcPassed(payload: { exchangeId: string; returnId: string; shopId: string }) {
    if (process.env.NODE_ENV === 'test' || process.env.DEBUG === 'true') {
      console.log(`[DEBUG] Listener started: handleQcPassed for exchangeId=${payload.exchangeId}`);
    }
    this.logger.log(`Received exchange.qc_passed for exchange ${payload.exchangeId}`);
    try {
      await this.fulfillmentService.createReplacementOrder(payload.exchangeId, payload.shopId);
      this.logger.log(`Successfully created replacement order for exchange ${payload.exchangeId}`);
      if (process.env.NODE_ENV === 'test' || process.env.DEBUG === 'true') {
        console.log(`[DEBUG] Listener committed: handleQcPassed for exchangeId=${payload.exchangeId}`);
      }
    } catch (error) {
      this.logger.error(`Failed to create replacement order for exchange ${payload.exchangeId}:`, error);
      // We don't rethrow here so we don't crash the Node process in an async listener
      // In a real production system with BullMQ, this would be a queued job that gets retried
    }
  }
}
