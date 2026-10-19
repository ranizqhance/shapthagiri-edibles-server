import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/sequelize';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Op } from 'sequelize';
import { Exchange, Return } from '@/models/return.model';
import { OrderItem } from '@/models';
import { ShopInventory, InventoryReservation } from '@/models';
import { ExchangeApprovedEvent } from '@/common/events/exchange-approved.event';
import { ExchangeFulfillmentService } from './exchange-fulfillment.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';

/** Returns whose replacement can never proceed. */
const TERMINAL_RETURN_STATUSES = ['rejected', 'closed', 'refunded', 'refund_processing'];

/**
 * Resumes replacements that stalled because the shop had no stock.
 *
 * Two stall shapes exist:
 *  1. Parked at approval  — Exchange = WAITING_FOR_REPLACEMENT_STOCK, no reservation.
 *  2. Stranded after QC   — the item was picked up and passed QC while parked, so
 *     createReplacementOrder threw "No active reservation" and the listener
 *     swallowed it. Exchange sits at QC_PASSED with newOrderId = null forever.
 *
 * Both previously required manual DB intervention. Reservation presence decides
 * whether we still need stock; the *Return* status decides the next step, because
 * the Exchange status alone can't tell us whether QC already happened.
 *
 * All reservation logic is reused via the existing exchange.approved listener —
 * nothing is duplicated here.
 */
@Injectable()
export class ReplacementRestockCron {
  private readonly logger = new Logger(ReplacementRestockCron.name);

  constructor(
    @InjectModel(Exchange) private exchangeModel: typeof Exchange,
    @InjectModel(Return) private returnModel: typeof Return,
    @InjectModel(OrderItem) private orderItemModel: typeof OrderItem,
    @InjectModel(ShopInventory) private inventoryModel: typeof ShopInventory,
    @InjectModel(InventoryReservation) private reservationModel: typeof InventoryReservation,
    private readonly eventEmitter: EventEmitter2,
    private readonly fulfillment: ExchangeFulfillmentService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async resumeParkedReplacements(): Promise<{ resumed: number; fulfilled: number; stillWaiting: number }> {
    const candidates = await this.exchangeModel.findAll({
      where: {
        [Op.or]: [
          { status: 'WAITING_FOR_REPLACEMENT_STOCK' },
          { status: 'QC_PASSED', newOrderId: null as any },
        ],
      },
      limit: 50,
    });

    let resumed = 0, fulfilled = 0, stillWaiting = 0;

    for (const ex of candidates) {
      try {
        const ret = await this.returnModel.findByPk(ex.returnId);
        if (!ret || TERMINAL_RETURN_STATUSES.includes(ret.status)) continue;

        const item = await this.orderItemModel.findByPk(ret.orderItemId);
        if (!item) continue;

        const reservation = await this.reservationModel.findOne({
          where: { referenceType: 'EXCHANGE', referenceId: ex.id, status: 'RESERVED' },
        });

        // ── No hold yet: only act once stock actually covers the order ──
        if (!reservation) {
          const inv = await this.inventoryModel.findOne({
            where: { shopId: item.shopId, variantId: ex.replacementVariantId, isActive: true },
          });
          if (!inv || Number(inv.quantity) < item.quantity) {
            stillWaiting++;
            continue;
          }

          // Reuse the canonical reservation path (row lock + idempotent + movement).
          this.eventEmitter.emit(
            'exchange.approved',
            new ExchangeApprovedEvent(ex.id, item.shopId, ex.replacementVariantId, item.quantity),
          );
          this.logger.log(`Stock available again — reserving for replacement ${ex.id}`);
          resumed++;
          continue; // the next tick advances it now that a hold exists
        }

        // ── Hold exists: the Return status tells us where we are ──
        if (ret.status === 'inspection_passed' && !ex.newOrderId) {
          if (ex.status !== 'QC_PASSED') await ex.update({ status: 'QC_PASSED' });
          await this.fulfillment.createReplacementOrder(ex.id, item.shopId);
          this.logger.log(`Created stranded replacement order for exchange ${ex.id}`);
          fulfilled++;
        } else if (ex.status === 'WAITING_FOR_REPLACEMENT_STOCK') {
          await ex.update({ status: 'APPROVED' });
          await this.notifications.notify(
            ret.userId,
            'Replacement back on track',
            'Good news — your replacement item is back in stock and your request is moving forward.',
          );
          this.logger.log(`Replacement ${ex.id} un-parked (stock reserved)`);
          resumed++;
        }
      } catch (err: any) {
        // One bad row must not stop the sweep.
        this.logger.error(`Failed to resume replacement ${ex.id}: ${err.message}`);
      }
    }

    if (resumed || fulfilled) {
      this.logger.log(`Restock sweep: ${resumed} resumed, ${fulfilled} fulfilled, ${stillWaiting} still waiting`);
    }
    return { resumed, fulfilled, stillWaiting };
  }
}
