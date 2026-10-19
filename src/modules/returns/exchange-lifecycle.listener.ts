import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/sequelize';
import { Exchange, Return } from '../../models/return.model';
import { Order } from '../../models/order.model';
import { OrderType } from '../../common/enums/order-status.enum';
import { ExchangeFulfillmentService } from './exchange-fulfillment.service';
import { Sequelize } from 'sequelize-typescript';

@Injectable()
export class ExchangeLifecycleListener {
  private readonly logger = new Logger(ExchangeLifecycleListener.name);

  constructor(
    private readonly sequelize: Sequelize,
    @InjectModel(Exchange) private exchangeModel: typeof Exchange,
    @InjectModel(Order) private orderModel: typeof Order,
    private readonly fulfillmentService: ExchangeFulfillmentService
  ) {}

  @OnEvent('order.packed', { async: true })
  async handleOrderPacked(payload: { orderId: string; shipmentId: string }) {
    await this.processExchangeUpdate(payload.orderId, async (exchange, t) => {
      // Consume the reservation since the item is physically packed
      await this.fulfillmentService.consumeReservation(exchange.id, t);
      await exchange.update({ status: 'PACKED' }, { transaction: t });
    });
  }

  @OnEvent('order.shipped', { async: true })
  async handleOrderShipped(payload: { orderId: string; shipmentId: string }) {
    await this.processExchangeUpdate(payload.orderId, async (exchange, t) => {
      await exchange.update({ status: 'REPLACEMENT_SHIPPED' }, { transaction: t });
    });
  }

  @OnEvent('order.delivered', { async: true })
  async handleOrderDelivered(payload: { orderId: string; shipmentId: string }) {
    await this.processExchangeUpdate(payload.orderId, async (exchange, t) => {
      await exchange.update({ status: 'REPLACEMENT_DELIVERED' }, { transaction: t });
      // Transition to completed next
      await exchange.update({ status: 'COMPLETED' }, { transaction: t });
      
      // Close parent return
      if (exchange.return) {
        await exchange.return.update({ status: 'closed' }, { transaction: t });
      }
    });
  }

  private async processExchangeUpdate(orderId: string, action: (exchange: Exchange, t: any) => Promise<void>) {
    try {
      const order = await this.orderModel.findByPk(orderId);
      if (!order || order.orderType !== OrderType.EXCHANGE_REPLACEMENT) {
        return; // Not an exchange order, ignore
      }

      await this.sequelize.transaction(async (t) => {
        const exchange = await this.exchangeModel.findOne({
          where: { newOrderId: order.id },
          lock: t.LOCK.UPDATE,
          transaction: t
        });

        if (exchange) {
          await exchange.reload({ include: [Return], transaction: t });
        }

        if (!exchange) {
          this.logger.warn(`Exchange not found for replacement order ${orderId}`);
          return;
        }

        await action(exchange, t);
      });
    } catch (error) {
      this.logger.error(`Error processing exchange update for order ${orderId}:`, error);
    }
  }
}
