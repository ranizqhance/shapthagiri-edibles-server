import { Injectable } from "@nestjs/common";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { Transaction, Op } from "sequelize";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { AuditLog, ProductVariant, Shop, ShopInventory, StockMovement, User } from "@/models";
import { Role } from "@/common/enums/role.enum";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { NotificationQueueService } from "../notifications/notification.queue";
import { BadRequestException, NotFoundException } from "@/common/errors/http";

export interface StockTransferInput {
  sourceShopId: string;
  destinationShopId: string;
  variantId: string;
  quantity: number;
  reason?: string;
}

/**
 * Inter-shop stock transfer — the single implementation behind both
 * `POST /shops/transfer` (Shop Network card) and `POST /inventory/transfer`.
 *
 * Guarantees:
 *  - atomic: source decrement, destination increment, both movement rows and the
 *    audit entry commit together or not at all;
 *  - no oversell: both inventory rows are locked FOR UPDATE in a deterministic
 *    order (by shopId) before the balance is read, so concurrent transfers of the
 *    same variant serialise instead of racing;
 *  - auditable: one `transfer_inventory` entry on success, one
 *    `INVENTORY_TRANSFER_FAILED` entry on every rejection — the failure entry is
 *    written OUTSIDE the transaction so it survives the rollback;
 *  - observable: TRANSFER_COMPLETED to admins and to both shops' managers,
 *    FAILED_STOCK_TRANSFER on rejection, plus LOW_STOCK if the source drops to or
 *    below its threshold as a result.
 */
@Injectable()
export class StockTransferService {
  constructor(
    @InjectModel(ShopInventory) private inv: typeof ShopInventory,
    @InjectModel(StockMovement) private movement: typeof StockMovement,
    @InjectModel(Shop) private shop: typeof Shop,
    @InjectModel(ProductVariant) private variant: typeof ProductVariant,
    @InjectModel(AuditLog) private auditLog: typeof AuditLog,
    @InjectModel(User) private user: typeof User,
    @InjectConnection() private sequelize: Sequelize,
    private eventEmitter: EventEmitter2,
    private notificationQueue: NotificationQueueService,
  ) {}

  /** Failure audit — deliberately outside any transaction so a rollback cannot erase it. */
  private async auditFailure(actorId: string | null, input: Partial<StockTransferInput>, reason: string) {
    await this.auditLog.create({
      actorId,
      action: "INVENTORY_TRANSFER_FAILED",
      entity: "ShopInventory",
      entityId: input.variantId ?? null,
      before: null,
      after: { ...input, reason },
    } as any);
    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.FAILED_STOCK_TRANSFER,
      variables: { ...input, reason },
    });
  }

  private async reject(actorId: string | null, input: Partial<StockTransferInput>, reason: string): Promise<never> {
    await this.auditFailure(actorId, input, reason);
    throw new BadRequestException("VALIDATION_FAILED", reason);
  }

  async transfer(actorId: string, input: StockTransferInput) {
    const { sourceShopId, destinationShopId, variantId, quantity, reason } = input;

    if (!Number.isInteger(quantity) || quantity <= 0) {
      await this.reject(actorId, input, "Transfer quantity must be a positive whole number");
    }
    if (sourceShopId === destinationShopId) {
      await this.reject(actorId, input, "Source and destination shops must be different");
    }

    // Validate the referenced entities up front so callers get a clear domain error
    // instead of a foreign-key violation surfacing as a generic database error.
    const [source, destination, variant] = await Promise.all([
      this.shop.findByPk(sourceShopId),
      this.shop.findByPk(destinationShopId),
      this.variant.findByPk(variantId),
    ]);
    if (!source) await this.reject(actorId, input, "Source shop not found");
    if (!destination) await this.reject(actorId, input, "Destination shop not found");
    if (!variant) await this.reject(actorId, input, "Product variant not found");
    // Stock may be drained OUT of a disabled shop (that is how you wind one down),
    // but never pushed INTO one — it could not fulfil the stock it received.
    if (!destination!.isActive) {
      await this.reject(actorId, input, `Destination shop "${destination!.name}" is disabled and cannot receive stock`);
    }

    let sourceRemaining = 0;
    let lowStockThreshold = 0;

    try {
      await this.sequelize.transaction(async (t) => {
        // Lock BOTH rows in a stable order (by shopId) before reading balances.
        // Deterministic ordering is what prevents two opposing transfers from
        // deadlocking; the lock itself is what prevents overselling.
        await this.inv.findAll({
          where: { shopId: { [Op.in]: [sourceShopId, destinationShopId] }, variantId },
          order: [["shopId", "ASC"]],
          lock: Transaction.LOCK.UPDATE,
          transaction: t,
        });

        const sourceInv = await this.inv.findOne({
          where: { shopId: sourceShopId, variantId },
          transaction: t,
        });
        const available = sourceInv?.quantity ?? 0;
        if (!sourceInv || available < quantity) {
          throw new BadRequestException(
            "VALIDATION_FAILED",
            `Insufficient stock in source shop. Available: ${available}, Required: ${quantity}`,
          );
        }

        const sourceBefore = sourceInv.toJSON();
        await sourceInv.update({ quantity: available - quantity }, { transaction: t });
        sourceRemaining = available - quantity;
        lowStockThreshold = Number(sourceInv.lowStockThreshold ?? 0);

        const [destInv, created] = await this.inv.findOrCreate({
          where: { shopId: destinationShopId, variantId },
          defaults: { shopId: destinationShopId, variantId, quantity: 0, isActive: true, lowStockThreshold: 5 } as any,
          transaction: t,
        });
        const destBefore = created ? null : destInv.toJSON();
        await destInv.update({ quantity: destInv.quantity + quantity }, { transaction: t });

        // Two ledger rows, matching the enum the rest of the system already uses:
        // TRANSFER_OUT is negative at the source, TRANSFER_IN positive at the target.
        await this.movement.bulkCreate([
          {
            shopId: sourceShopId, variantId, type: "TRANSFER_OUT", quantity: -quantity,
            reason: reason || "Inter-shop transfer", createdBy: actorId,
            referenceType: "Shop", referenceId: destinationShopId,
          },
          {
            shopId: destinationShopId, variantId, type: "TRANSFER_IN", quantity,
            reason: reason || "Inter-shop transfer", createdBy: actorId,
            referenceType: "Shop", referenceId: sourceShopId,
          },
        ] as any, { transaction: t });

        await this.auditLog.create({
          actorId,
          action: "transfer_inventory",
          entity: "ShopInventory",
          entityId: variantId,
          before: { source: sourceBefore, destination: destBefore },
          after: {
            source: sourceInv.toJSON(), destination: destInv.toJSON(),
            quantity, reason: reason ?? null,
            sourceShopId, destinationShopId,
          },
        } as any, { transaction: t });
      });
    } catch (err: any) {
      await this.auditFailure(actorId, input, err?.message ?? "Transfer failed");
      throw err;
    }

    await this.notify(source!, destination!, variantId, quantity, sourceRemaining, lowStockThreshold);
    return { success: true, transferred: quantity, sourceRemaining };
  }

  /** Post-commit fan-out. Never allowed to fail the transfer that already committed. */
  private async notify(
    source: Shop, destination: Shop, variantId: string,
    quantity: number, sourceRemaining: number, threshold: number,
  ) {
    try {
      const variables = {
        fromShopId: source.id, toShopId: destination.id,
        fromShopName: source.name, toShopName: destination.name,
        variantId, quantity,
      };
      this.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.TRANSFER_COMPLETED,
        variables,
      });

      const managers = await this.user.findAll({
        where: { role: Role.SHOP_MANAGER, shopId: { [Op.in]: [source.id, destination.id] } },
        attributes: ["id"],
      });
      for (const m of managers) {
        await this.notificationQueue.enqueue(m.id, NotificationEventType.TRANSFER_COMPLETED, variables);
      }

      // The source may have been drained below its reorder point by this transfer.
      if (threshold > 0 && sourceRemaining <= threshold) {
        this.eventEmitter.emit("admin.notify", {
          eventType: sourceRemaining === 0 ? NotificationEventType.OUT_OF_STOCK : NotificationEventType.LOW_STOCK,
          variables: {
            productId: variantId, shopId: source.id, shopName: source.name,
            quantity: sourceRemaining, threshold,
          },
        });
      }
    } catch {
      // Swallow: the stock movement is committed and correct. A notification
      // outage must not surface as a failed transfer to the operator.
    }
  }
}
