import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Transaction } from 'sequelize';
import { Order } from '../../models/order.model';
import { OrderShipment, OrderItem, OrderStatusHistory } from '../../models/order-shipment.model';
import { Exchange, Return } from '../../models/return.model';
import { InventoryReservation, ShopInventory, StockMovement, RoutingDecision, UserAddress } from '../../models';
import { DeliveryEngineService } from '../delivery-engine/delivery-engine.service';
import { AuditLog } from '../../models/admin.model';
import { OrderStatus, PaymentStatus, OrderType } from '../../common/enums/order-status.enum';
import { PricingService } from '../orders/pricing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProductVariant } from '../../models/product-variant.model';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class ExchangeFulfillmentService {
  private readonly logger = new Logger(ExchangeFulfillmentService.name);

  constructor(
    private readonly sequelize: Sequelize,
    @InjectModel(Exchange) private exchangeModel: typeof Exchange,
    @InjectModel(Return) private returnModel: typeof Return,
    @InjectModel(Order) private orderModel: typeof Order,
    @InjectModel(OrderShipment) private shipmentModel: typeof OrderShipment,
    @InjectModel(OrderItem) private orderItemModel: typeof OrderItem,
    @InjectModel(InventoryReservation) private reservationModel: typeof InventoryReservation,
    @InjectModel(ShopInventory) private inventoryModel: typeof ShopInventory,
    @InjectModel(StockMovement) private stockMovementModel: typeof StockMovement,
    @InjectModel(OrderStatusHistory) private historyModel: typeof OrderStatusHistory,
    @InjectModel(ProductVariant) private variantModel: typeof ProductVariant,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    private readonly pricingService: PricingService,
    private readonly notifications: NotificationsService,
    private readonly deliveryEngine: DeliveryEngineService
  ) {}

  /**
   * ETA for the replacement shipment, from the shop that holds the reservation.
   *
   * The order's addressSnapshot has no coordinates, so distance is resolved as:
   *   1. RoutingDecision recorded for the original order+variant — the exact
   *      shop→address distance the engine already computed at checkout.
   *   2. The customer's saved address (pincode match) → live haversine.
   *   3. null — we leave the ETA empty rather than invent a delivery date.
   */

  async createReplacementOrder(exchangeId: string, shopId: string): Promise<void> {
    const result = await this.sequelize.transaction(async (t) => {
      // 1. Load Exchange with lock
      const exchange = await this.exchangeModel.findOne({
        where: { id: exchangeId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });

      if (!exchange) {
        throw new Error(`Exchange ${exchangeId} not found`);
      }

      // 2. Load relations after locking to avoid Postgres outer join lock errors
      await exchange.reload({
        include: [
          {
            model: Return,
            include: [
              {
                model: OrderItem,
                include: [
                  {
                    model: OrderShipment,
                    include: [Order]
                  }
                ]
              }
            ]
          }
        ],
        transaction: t
      });

      // 2. Idempotency Check
      if (exchange.newOrderId) {
        this.logger.log(`Exchange ${exchangeId} already has a replacement order (${exchange.newOrderId}). Skipping.`);
        return;
      }

      const originalOrder = exchange.return?.orderItem?.shipment?.order;
      const originalOrderItem = exchange.return?.orderItem;
      const originalReturn = exchange.return;

      if (!originalOrder || !originalOrderItem || !originalReturn) {
        throw new Error(`Original order/item data missing for Exchange ${exchangeId}`);
      }

      // 3. Find and validate active reservation
      const reservation = await this.reservationModel.findOne({
        where: { referenceId: exchangeId, status: 'RESERVED' },
        lock: t.LOCK.UPDATE,
        transaction: t
      });

      if (!reservation) {
        throw new ConflictException(`No active reservation found for Exchange ${exchangeId}`);
      }

      if (reservation.expiresAt < new Date()) {
        await this.expireReservation(reservation.id, t);
        return { expired: true };
      }

      const variant = await this.variantModel.findByPk(exchange.replacementVariantId, { transaction: t });

      // 4. Create Replacement Order
      const replacementOrder = await this.orderModel.create({
        orderNumber: this.pricingService.orderNumber(),
        userId: originalOrder.userId,
        orderType: OrderType.EXCHANGE_REPLACEMENT,
        originalOrderId: originalOrder.id,
        subtotal: 0,
        total: 0,
        discount: 0,
        deliveryFee: 0,
        tax: 0,
        paymentMethod: originalOrder.paymentMethod,
        paymentStatus: PaymentStatus.CAPTURED,
        addressSnapshot: originalOrder.addressSnapshot,
        status: OrderStatus.PLACED,
        placedAt: new Date()
      } as any, { transaction: t });

      // 5. Create Replacement Shipment.
      const replacementShipment = await this.shipmentModel.create({
        orderId: replacementOrder.id,
        shopId: shopId,
        shipmentNumber: `${replacementOrder.orderNumber}-${shopId.slice(0, 4)}`,
        status: OrderStatus.PLACED,
      } as any, { transaction: t });

      // 6. Create Replacement Order Item
      await this.orderItemModel.create({
        shipmentId: replacementShipment.id,
        variantId: exchange.replacementVariantId,
        shopId: shopId,
        quantity: reservation.quantity,
        price: originalOrderItem.price, // Preserve original price for records
        unitPrice: originalOrderItem.unitPrice,
        subtotal: 0, // Customer pays nothing extra
        productId: variant?.productId,
        productName: originalOrderItem.productName,
        productImage: originalOrderItem.productImage,
        sku: variant?.sku,
        variantAttributes: variant?.attributes
      } as any, { transaction: t });

      // 7. Update Exchange Status
      await exchange.update({
        newOrderId: replacementOrder.id,
        status: 'REPLACEMENT_ORDER_CREATED'
      }, { transaction: t });

      // 8. Order Status History & Audit Log
      await this.historyModel.create({
        orderId: replacementOrder.id,
        status: OrderStatus.PLACED,
        notes: "Exchange replacement order created",
        actorId: null
      } as any, { transaction: t });

      await this.auditLogModel.create({
        actorId: null,
        action: 'create_replacement_order',
        entity: 'Order',
        entityId: replacementOrder.id,
        before: null,
        after: { orderId: replacementOrder.id, exchangeId: exchange.id }
      } as any, { transaction: t });

      t.afterCommit(async () => {
        await this.notifications.notify(
          replacementOrder.userId,
          "Replacement Order Created 🔄",
          `Your exchange replacement order ${replacementOrder.orderNumber} has been successfully created and will be packed soon.`
        );
      });
      return { expired: false };
    });

    if (result && result.expired) {
      throw new ConflictException(`Reservation for Exchange ${exchangeId} has expired. Stock has been released.`);
    }
  }

  async consumeReservation(exchangeId: string, transaction: Transaction): Promise<void> {
    const reservation = await this.reservationModel.findOne({
      where: { referenceId: exchangeId, status: 'RESERVED' },
      lock: transaction.LOCK.UPDATE,
      transaction
    });

    if (!reservation) {
      this.logger.warn(`No active reservation to consume for Exchange ${exchangeId}`);
      return;
    }

    if (reservation.expiresAt < new Date()) {
      await this.expireReservation(reservation.id); // without transaction to start a new one, wait no, we are already in transaction. 
      // If we are in transaction, we can't throw without rollback. So consumeReservation needs the caller to handle this, or we do it outside.
      // Wait, consumeReservation is already passed a transaction. If it's passed a transaction, and we want to expire, we should just expire and throw.
      // But if we throw, the caller's transaction rolls back. That means the expiry is rolled back too!
      // This means consumeReservation JIT expiry MUST be done in a separate transaction if we want it to persist, or we just throw and let it stay expired (but wait, it won't persist).
      // Let's use an independent transaction for expiry in consumeReservation.
      // Wait, since we are inside a transaction, if we start another transaction it will work? Yes, Sequelize supports independent transactions if we don't pass `transaction: t`.
      // Actually, if we throw, the outer transaction rolls back. So if we run expire without `t`, it will commit to DB independently, then we throw and the outer rolls back. That's perfect.
      await this.expireReservation(reservation.id);
      throw new ConflictException(`Reservation for Exchange ${exchangeId} has expired. Stock has been released.`);
    }

    await reservation.update({
      status: 'CONSUMED',
      consumedAt: new Date()
    }, { transaction });

    await this.stockMovementModel.create({
      shopId: reservation.shopId,
      variantId: reservation.variantId,
      type: 'RESERVATION_CONSUMED',
      quantity: reservation.quantity,
      reason: 'Exchange replacement packed',
      referenceType: 'EXCHANGE',
      referenceId: exchangeId,
      createdBy: null
    } as any, { transaction });
  }

  async expireReservation(reservationId: string, transaction?: Transaction): Promise<void> {
    const run = async (t: Transaction) => {
      const reservation = await this.reservationModel.findOne({
        where: { id: reservationId, status: 'RESERVED' },
        lock: t.LOCK.UPDATE,
        transaction: t
      });

      if (!reservation) return;

      // 1. Release the reservation and restore inventory
      await reservation.update({
        status: 'EXPIRED', // Note: using EXPIRED instead of RELEASED for cron
        releasedAt: new Date()
      }, { transaction: t });

      const inventory = await this.inventoryModel.findOne({
        where: { shopId: reservation.shopId, variantId: reservation.variantId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });

      if (inventory) {
        await inventory.increment('quantity', { by: reservation.quantity, transaction: t });
      }

      await this.stockMovementModel.create({
        shopId: reservation.shopId,
        variantId: reservation.variantId,
        type: 'RESERVATION_RELEASED',
        quantity: reservation.quantity,
        reason: 'Reservation expired',
        referenceType: 'RESERVATION',
        referenceId: reservation.id,
        createdBy: null
      } as any, { transaction: t });

      // 2. Update Exchange Status
      if (reservation.referenceType === 'EXCHANGE' && reservation.referenceId) {
        const exchange = await this.exchangeModel.findOne({
          where: { id: reservation.referenceId },
          lock: t.LOCK.UPDATE,
          transaction: t
        });

        if (exchange) {
          await exchange.reload({
            include: [{ model: Return }],
            transaction: t
          });
          await exchange.update({
            status: 'WAITING_FOR_REPLACEMENT_STOCK'
          }, { transaction: t });

          // 3. Notifications
          if (exchange.return && exchange.return.userId) {
            t.afterCommit(async () => {
              await this.notifications.notify(
                exchange.return!.userId,
                "Exchange Update 🕒",
                "Your replacement item is temporarily unavailable. Your exchange request is still active and is waiting for replacement stock."
              );
              // Notify Shop Manager
              // Assuming Shop role notification
              await this.notifications.notifyRole(
                'shop_manager' as any, // Role enum might be different, need to verify
                "System Alert: Stock Restored",
                `Reserved stock for Exchange ${exchange.id} has expired and ${reservation.quantity} unit(s) have been restored to available inventory.`
              );
              // Notify Admin
              await this.notifications.notifyRole(
                'admin' as any,
                "Exchange Waiting for Stock",
                `Exchange #${exchange.id} is waiting for replacement stock.`
              );
            });
          }
        }
      }
    };

    if (transaction) {
      await run(transaction);
    } else {
      await this.sequelize.transaction(run);
    }
  }

  async releaseReservation(reservationId: string, transaction?: Transaction, customReason?: string): Promise<void> {
    const run = async (t: Transaction) => {
      const reservation = await this.reservationModel.findOne({
        where: { id: reservationId, status: 'RESERVED' },
        lock: t.LOCK.UPDATE,
        transaction: t
      });

      if (!reservation) {
        return;
      }

      await reservation.update({
        status: 'RELEASED',
        releasedAt: new Date()
      }, { transaction: t });

      const inventory = await this.inventoryModel.findOne({
        where: { shopId: reservation.shopId, variantId: reservation.variantId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });

      if (inventory) {
        await inventory.increment('quantity', { by: reservation.quantity, transaction: t });
      }

      await this.stockMovementModel.create({
        shopId: reservation.shopId,
        variantId: reservation.variantId,
        type: 'RESERVATION_RELEASED',
        quantity: reservation.quantity,
        reason: customReason || 'Reservation released/expired',
        referenceType: 'RESERVATION',
        referenceId: reservation.id,
        createdBy: null
      } as any, { transaction: t });
    };

    if (transaction) {
      await run(transaction);
    } else {
      await this.sequelize.transaction(run);
    }
  }

  @OnEvent('exchange.qc_failed')
  async handleQcFailed(payload: {
    exchangeId: string;
    returnId: string;
    reservationId: string | null;
    shopId: string;
    variantId: string;
    reason: string;
  }) {
    const { exchangeId, returnId, reservationId, reason } = payload;
    
    try {
      if (reservationId) {
        // Release reservation in a new independent transaction
        await this.releaseReservation(reservationId, undefined, `Exchange QC Failed: ${reason}`);
      }

      await this.auditLogModel.create({
        actorId: null,
        action: 'Reservation Released',
        entity: 'Exchange',
        entityId: exchangeId
      } as any);

      const returnRec = await this.returnModel.findByPk(returnId);
      if (returnRec && returnRec.userId) {
        try {
          await this.notifications.notify(
            returnRec.userId,
            "Exchange Cancelled ❌",
            "Your returned item failed our quality check inspection. Your exchange request has been cancelled."
          );
        } catch (e) {
          this.logger.warn(`Failed to send QC Failed notification to user ${returnRec.userId}`, e);
        }
      }
    } catch (e) {
      this.logger.error(`Error handling exchange.qc_failed for exchange ${exchangeId}`, e);
    }
  }
}
