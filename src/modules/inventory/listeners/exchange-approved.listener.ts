import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Sequelize } from 'sequelize-typescript';
import { Transaction, QueryTypes } from 'sequelize';
import { ExchangeApprovedEvent } from '@/common/events/exchange-approved.event';
import { InventoryReservation, ShopInventory, StockMovement, Exchange, Return } from '@/models';
import { NotificationsService } from '@/modules/notifications/notifications.service';

/** How long replacement stock stays held for an approved exchange. */
const EXCHANGE_HOLD_DAYS = 10;

@Injectable()
export class ExchangeApprovedListener {
  private readonly logger = new Logger(ExchangeApprovedListener.name);

  constructor(
    private readonly sequelize: Sequelize,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent('exchange.approved')
  async handleExchangeApprovedEvent(event: ExchangeApprovedEvent) {
    this.logger.log(`Handling exchange.approved event for exchange ${event.exchangeId}`);

    const transaction = await this.sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED
    });

    try {
      // 1. Row-level locking to prevent race conditions during reservation
      const inventory = await ShopInventory.findOne({
        where: { shopId: event.shopId, variantId: event.variantId },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (!inventory) {
        // No stock row for this shop/variant is simply "unavailable", not a
        // system fault — park it for restock rather than throwing into a retry loop.
        this.logger.warn(`No inventory record for shop ${event.shopId} / variant ${event.variantId} — parking exchange ${event.exchangeId}`);
        await transaction.rollback();
        await this.parkForRestock(event, 0);
        return;
      }

      if (inventory.quantity < event.quantity) {
        this.logger.warn(`Insufficient stock for exchange ${event.exchangeId}. Available: ${inventory.quantity}, Required: ${event.quantity}`);
        await transaction.rollback();
        await this.parkForRestock(event, inventory.quantity);
        return;
      }

      // 2. Idempotency Check using the database partial unique index constraint.
      // We will attempt to insert the reservation, and if it fails due to the unique constraint, it means this event was already processed.
      // The replacement is only created once the returned item has been picked
      // up and passed inspection — typically 3–6 days after approval. The old
      // 48-hour hold expired first, so exchanges failed with "reservation expired"
      // and no replacement order was ever made.
      const expiresAt = new Date(Date.now() + EXCHANGE_HOLD_DAYS * 24 * 3600_000);

      const [reservation, created] = await InventoryReservation.findOrCreate({
        where: {
          referenceType: 'EXCHANGE',
          referenceId: event.exchangeId,
          status: 'RESERVED'
        },
        defaults: {
          referenceType: 'EXCHANGE',
          referenceId: event.exchangeId,
          variantId: event.variantId,
          shopId: event.shopId,
          quantity: event.quantity,
          status: 'RESERVED',
          expiresAt,
        } as any,
        transaction,
      });

      if (!created) {
        this.logger.warn(`Idempotency caught: Reservation already exists for exchange ${event.exchangeId}`);
        await transaction.rollback();
        return;
      }

      // 3. Update inventory
      await inventory.decrement('quantity', { by: event.quantity, transaction });

      // 4. Record stock movement
      await StockMovement.create({
        shopId: event.shopId,
        variantId: event.variantId,
        type: 'RESERVATION_HOLD',
        quantity: -event.quantity,
        referenceType: 'EXCHANGE',
        referenceId: event.exchangeId,
        reason: `Reserved for exchange ${event.exchangeId}`,
      } as any, { transaction });

      await transaction.commit();
      this.logger.log(`Successfully reserved inventory for exchange ${event.exchangeId}`);
    } catch (error: any) {
      await transaction.rollback();
      this.logger.error(`Failed to process exchange.approved for ${event.exchangeId}: ${error.message}`, error.stack);
      // Depending on architecture, we might throw the error to let BullMQ retry, or just log.
      // We will throw so BullMQ can catch it and retry if needed.
      throw error;
    }
  }

  /**
   * Stock-unavailable path: keep the exchange pending in
   * WAITING_FOR_REPLACEMENT_STOCK and tell the customer. The request is not
   * rejected — a restock lets an operator re-approve it.
   */
  private async parkForRestock(event: ExchangeApprovedEvent, available: number): Promise<void> {
    const exchange = await Exchange.findByPk(event.exchangeId);
    if (!exchange) {
      this.logger.error(`Exchange ${event.exchangeId} not found while parking for restock`);
      return;
    }

    await exchange.update({ status: 'WAITING_FOR_REPLACEMENT_STOCK' });

    const ret = await Return.findByPk(exchange.returnId);
    if (!ret) return;

    try {
      await this.notifications.notify(
        ret.userId,
        'Replacement on hold',
        'Your replacement is approved but the item is temporarily out of stock. We have reserved your request and will ship it as soon as stock arrives.',
      );
    } catch (err: any) {
      // Never let a notification failure mask the status update.
      this.logger.error(`Failed to notify user for exchange ${event.exchangeId}: ${err.message}`);
    }

    this.logger.log(`Exchange ${event.exchangeId} parked: WAITING_FOR_REPLACEMENT_STOCK (available=${available}, required=${event.quantity})`);
  }
}
