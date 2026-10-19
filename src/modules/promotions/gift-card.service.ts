import { Injectable, Logger, Inject, forwardRef } from "@nestjs/common";
import {
  BadRequestException as AppBadRequestException,
  NotFoundException as AppNotFoundException,
} from "@/common/errors/http";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize, Transaction } from "sequelize";
import { Op } from "sequelize";
import { GiftCard, GiftCardTransaction, AuditLog, User, IdempotencyKey } from "@/models";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { NotificationsService } from "@/modules/notifications/notifications.service";
import { NotificationQueueService } from "../notifications/notification.queue";
import { CreateGiftCardDto, UpdateGiftCardDto, RechargeGiftCardDto, GiftCardStatus } from "@/common/dto/gift-card.dto";
import { withIdempotency } from "@/common/utils/idempotency.util";
import { TrackingGateway } from "../tracking/tracking.gateway";
import crypto from "node:crypto";

/**
 * This service used to throw Nest's built-in exceptions, which AllExceptionsFilter
 * does not translate — every gift-card rejection surfaced to the customer as a
 * generic 500 "Something went wrong on our end", hiding the real reason.
 *
 * These thin subclasses keep the existing single-message call sites while
 * producing the project's standard AppException envelope (422 / 404 with the
 * message intact).
 */
class BadRequestException extends AppBadRequestException {
  constructor(msg?: string) { super("VALIDATION_FAILED", msg); }
}
class NotFoundException extends AppNotFoundException {
  constructor(msg?: string) { super("NOT_FOUND", msg); }
}

@Injectable()
export class GiftCardService {
  private readonly logger = new Logger("GiftCardService");

  constructor(
    @InjectConnection() private sequelize: Sequelize,
    @InjectModel(GiftCard) private giftCardModel: typeof GiftCard,
    @InjectModel(GiftCardTransaction) private transactionModel: typeof GiftCardTransaction,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(IdempotencyKey) private idem: typeof IdempotencyKey,
    private eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => NotificationsService))
    private notifications: NotificationsService,
    @Inject(forwardRef(() => NotificationQueueService))
    private queueService: NotificationQueueService,
    private trackingGateway: TrackingGateway,
  ) {}

  private generateCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "GC-";
    for (let i = 0; i < 12; i++) {
      if (i > 0 && i % 4 === 0) code += "-";
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  async createGiftCard(data: CreateGiftCardDto, actorId: string): Promise<GiftCard> {
    return this.sequelize.transaction(async (t) => {
      // Normalize custom codes to uppercase so redemption is case-insensitive
      // (auto-generated codes are already uppercase). Lookups uppercase too.
      const code = (data.code?.trim() || this.generateCode()).toUpperCase();
      const initialBalance = data.initialBalance ?? data.balance ?? 0;
      
      const giftCard = await this.giftCardModel.create(
        {
          ...data,
          code,
          initialBalance,
          balance: initialBalance,
          createdBy: actorId,
          updatedBy: actorId,
        } as any,
        { transaction: t }
      );

      await this.transactionModel.create(
        {
          giftCardId: giftCard.id,
          type: "issue",
          amount: initialBalance,
          balanceAfter: initialBalance,
          actorId,
          notes: "Initial balance issued",
          statusTransition: "active",
        } as any,
        { transaction: t }
      );

      await this.auditLogModel.create(
        {
          actorId,
          action: "CREATE",
          entity: "GiftCard",
          entityId: giftCard.id,
          after: giftCard.toJSON(),
        } as any,
        { transaction: t }
      );

      t.afterCommit(() => {
        this.eventEmitter.emit("admin.notify", {
          eventType: "GIFT_CARD_CREATED",
          variables: { giftCardId: giftCard.id, code: giftCard.code },
        });
        
        this.trackingGateway.emitToAdmins("dashboard.giftcard_updated", { id: giftCard.id, action: "created" });

        if (giftCard.customerId) {
          // Notify customer asynchronously
          this.queueService.enqueue(giftCard.customerId, "GIFT_CARD_RECEIVED" as any, { 
             code: giftCard.code, 
             balance: giftCard.balance 
          });
          this.trackingGateway.emitToUser(giftCard.customerId, "wallet.updated", { giftCardId: giftCard.id, balance: giftCard.balance });
        }
      });

      return giftCard;
    });
  }

  async updateGiftCardStatus(id: string, data: UpdateGiftCardDto, actorId: string): Promise<GiftCard> {
    return this.sequelize.transaction(async (t) => {
      const giftCard = await this.giftCardModel.findByPk(id, { transaction: t });
      if (!giftCard) throw new NotFoundException("Gift card not found");

      const before = giftCard.toJSON();

      await giftCard.update(
        { ...data, updatedBy: actorId },
        { transaction: t }
      );

      if (data.status && before.status !== data.status) {
        await this.transactionModel.create(
          {
            giftCardId: giftCard.id,
            type: "status_change",
            amount: 0,
            balanceAfter: giftCard.balance,
            actorId,
            notes: data.notes || `Status changed to ${data.status}`,
            statusTransition: data.status,
          } as any,
          { transaction: t }
        );
      }

      await this.auditLogModel.create(
        {
          actorId,
          action: "UPDATE_STATUS",
          entity: "GiftCard",
          entityId: giftCard.id,
          before,
          after: giftCard.toJSON(),
        } as any,
        { transaction: t }
      );

      t.afterCommit(() => {
        this.eventEmitter.emit("admin.notify", {
          eventType: "GIFT_CARD_UPDATED",
          variables: { giftCardId: giftCard.id, status: data.status },
        });
        this.trackingGateway.emitToAdmins("dashboard.giftcard_updated", { id: giftCard.id, status: data.status });
        if (giftCard.customerId) {
          this.trackingGateway.emitToUser(giftCard.customerId, "wallet.updated", { giftCardId: giftCard.id, status: data.status });
        }
      });

      return giftCard;
    });
  }

  async rechargeGiftCard(id: string, data: RechargeGiftCardDto, actorId: string, idemKey?: string): Promise<GiftCard> {
    return withIdempotency(this.idem, { key: idemKey, endpoint: "giftcards.recharge", payload: { id, ...data } }, () =>
      this.sequelize.transaction(async (t) => {
        const giftCard = await this.giftCardModel.findByPk(id, { lock: t.LOCK.UPDATE, transaction: t });
        if (!giftCard) throw new NotFoundException("Gift card not found");

        if (giftCard.status !== GiftCardStatus.ACTIVE) {
          throw new BadRequestException(`Cannot recharge a ${giftCard.status} gift card.`);
        }

        const newBalance = Number(giftCard.balance) + Number(data.amount);

        await giftCard.update(
          { balance: newBalance, updatedBy: actorId },
          { transaction: t }
        );

        await this.transactionModel.create(
          {
            giftCardId: giftCard.id,
            type: "recharge",
            amount: data.amount,
            balanceAfter: newBalance,
            actorId,
            idempotencyKey: idemKey,
            notes: data.notes || "Manual recharge",
          } as any,
          { transaction: t }
        );

        await this.auditLogModel.create(
          {
            actorId,
            action: "RECHARGE",
            entity: "GiftCard",
            entityId: giftCard.id,
            after: giftCard.toJSON(),
          } as any,
          { transaction: t }
        );

        t.afterCommit(() => {
          this.eventEmitter.emit("admin.notify", {
            eventType: "GIFT_CARD_RECHARGED",
            variables: { giftCardId: giftCard.id, amount: data.amount },
          });
          this.trackingGateway.emitToAdmins("dashboard.giftcard_updated", { id: giftCard.id, action: "recharged" });

          if (giftCard.customerId) {
            this.queueService.enqueue(giftCard.customerId, "GIFT_CARD_RECHARGED" as any, { 
               code: giftCard.code, 
               amount: data.amount,
               newBalance
            });
            this.trackingGateway.emitToUser(giftCard.customerId, "wallet.updated", { giftCardId: giftCard.id, balance: newBalance });
          }
        });

        return giftCard;
      })
    );
  }

  async getGiftCardDetails(id: string): Promise<any> {
    const giftCard = await this.giftCardModel.findByPk(id, {
      include: [{ model: GiftCardTransaction, as: "transactions" }],
    });
    if (!giftCard) throw new NotFoundException("Gift card not found");
    return giftCard;
  }

  async getDashboardSummary(): Promise<any> {
    const totalIssued = await this.giftCardModel.sum("initialBalance") || 0;
    const totalRemaining = await this.giftCardModel.sum("balance", { where: { status: GiftCardStatus.ACTIVE } }) || 0;
    const activeCount = await this.giftCardModel.count({ where: { status: GiftCardStatus.ACTIVE } });
    const expiredCount = await this.giftCardModel.count({ where: { status: GiftCardStatus.EXPIRED } });
    const redeemedCount = await this.transactionModel.count({ where: { type: "redemption" } });
    const totalRedeemedAmount = Math.abs(await this.transactionModel.sum("amount", { where: { type: "redemption" } }) || 0);

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    
    const monthlyIssuedCount = await this.giftCardModel.count({ where: { createdAt: { [Op.gte]: startOfMonth } } });
    const monthlyRedeemedAmount = Math.abs(await this.transactionModel.sum("amount", { where: { type: "redemption", createdAt: { [Op.gte]: startOfMonth } } }) || 0);

    const lowBalanceCount = await this.giftCardModel.count({ 
      where: { 
        status: GiftCardStatus.ACTIVE,
        balance: { [Op.lt]: 100, [Op.gt]: 0 }
      } 
    });

    const redemptionRate = totalIssued > 0 ? ((totalRedeemedAmount / totalIssued) * 100).toFixed(2) : 0;

    return {
      totalIssued,
      totalRemaining,
      totalRedeemedAmount,
      activeCount,
      expiredCount,
      redeemedCount,
      monthlyIssuedCount,
      monthlyRedeemedAmount,
      lowBalanceCount,
      redemptionRate
    };
  }

  /**
   * Gift cards, newest first.
   *
   * The cap is enforced HERE, at the sink, not at the controller. Both
   * callers took `?limit=` straight off the query string, so
   * `?limit=99999999` dumped the entire table — codes, balances and customer
   * email addresses — into one in-memory string. Clamping at the controller
   * would have left the next caller free to repeat the mistake.
   */
  async listGiftCards(limit: number): Promise<{ items: any[] }> {
    const MAX = 500;
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX);
    const items: any[] = await this.giftCardModel.findAll({
      limit: safeLimit,
      order: [["createdAt", "DESC"]],
      raw: true
    });
    
    // Quick user mapping to avoid missing association errors
    if (items.length > 0) {
      const customerIds = [...new Set(items.map(i => i.customerId).filter(Boolean))] as string[];
      if (customerIds.length > 0) {
        const users = await this.userModel.findAll({ 
          where: { id: customerIds },
          attributes: ["id", "name", "email"],
          raw: true 
        });
        const userMap = new Map(users.map(u => [u.id, u]));
        items.forEach(i => {
          if (i.customerId) {
            i.customer = userMap.get(i.customerId) || null;
          }
        });
      }
    }
    
    return { items };
  }

  async getMyGiftCards(customerId: string, query: { page?: number; limit?: number; status?: string; search?: string }): Promise<any> {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const whereClause: any = { customerId };
    
    if (query.status && query.status !== 'all') {
      if (query.status === 'used') {
        whereClause.balance = 0;
      } else {
        whereClause.status = query.status;
      }
    }
    
    if (query.search) {
      whereClause.code = { [Op.iLike]: `%${query.search}%` };
    }

    const { rows, count } = await this.giftCardModel.findAndCountAll({
      where: whereClause,
      include: [{ model: GiftCardTransaction, as: "transactions" }],
      limit,
      offset,
      order: [
        [
          this.sequelize.literal(`CASE WHEN "GiftCard"."status" = 'active' AND "GiftCard"."balance" > 0 THEN 1 ELSE 2 END`), 
          'ASC'
        ],
        ['expiresAt', 'ASC NULLS LAST'],
        ['createdAt', 'DESC']
      ]
    });

    const items = rows.map(card => {
      const json = card.toJSON() as any;
      
      let totalRedeemed = 0;
      let totalRefunded = 0;
      let lastUsedDate = null;
      const orderIds = new Set<string>();

      if (json.transactions) {
        json.transactions.forEach((tx: any) => {
          if (tx.type === 'redemption') {
            totalRedeemed += Number(tx.amount);
            lastUsedDate = tx.createdAt > (lastUsedDate || new Date(0)) ? tx.createdAt : lastUsedDate;
          }
          if (tx.type === 'refund') {
            totalRefunded += Number(tx.amount);
          }
          if (tx.orderId) {
            orderIds.add(tx.orderId);
          }
        });
      }

      json.analytics = {
        totalRedeemed,
        totalRefunded,
        lastUsedDate,
        numberOfOrders: orderIds.size
      };
      
      return json;
    });

    return {
      items,
      meta: {
        page,
        limit,
        totalItems: count,
        totalPages: Math.ceil(count / limit),
        hasPrev: page > 1,
        hasNext: page * limit < count,
      }
    };
  }

  async claimGiftCard(code: string, customerId: string): Promise<any> {
    code = code?.trim().toUpperCase();
    return this.sequelize.transaction(async (t) => {
      const giftCard = await this.giftCardModel.findOne({
        where: { code },
        lock: t.LOCK.UPDATE,
        transaction: t,
      });

      if (!giftCard) {
        throw new BadRequestException("Invalid or unavailable Gift Card.");
      }

      if (giftCard.customerId === customerId) {
         throw new BadRequestException("You have already claimed this Gift Card.");
      }

      if (giftCard.customerId !== null || giftCard.status !== GiftCardStatus.ACTIVE || giftCard.balance <= 0 || (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date())) {
        throw new BadRequestException("Invalid or unavailable Gift Card.");
      }

      await giftCard.update({ customerId, updatedBy: customerId }, { transaction: t });

      await this.transactionModel.create(
        {
          giftCardId: giftCard.id,
          type: "status_change",
          amount: 0,
          balanceAfter: giftCard.balance,
          actorId: customerId,
          customerId,
          notes: "Claimed by customer",
        } as any,
        { transaction: t }
      );

      await this.auditLogModel.create(
        {
          actorId: customerId,
          action: "CLAIM",
          entity: "GiftCard",
          entityId: giftCard.id,
          after: giftCard.toJSON(),
        } as any,
        { transaction: t }
      );

      t.afterCommit(() => {
        this.queueService.enqueue(customerId, "GIFT_CARD_CLAIMED" as any, { code: giftCard.code, balance: giftCard.balance });
        this.trackingGateway.emitToUser(customerId, "wallet.updated", { giftCardId: giftCard.id, balance: giftCard.balance });
        this.trackingGateway.emitToUser(customerId, "giftcard.claimed", { giftCardId: giftCard.id });
        this.trackingGateway.emitToAdmins("dashboard.giftcard_claimed", { giftCardId: giftCard.id, customerId });
      });

      return giftCard;
    });
  }

  async validateForCart(code: string, customerId: string, subtotal: number, cartItems?: any[]): Promise<GiftCard> {
    code = code?.trim().toUpperCase();
    const giftCard = await this.giftCardModel.findOne({ where: { code } });
    if (!giftCard) {
      throw new BadRequestException("Invalid gift card code");
    }

    if (giftCard.status !== GiftCardStatus.ACTIVE) {
      await this.recordFailedAttempt(giftCard);
      throw new BadRequestException(`This gift card is ${giftCard.status}`);
    }

    if (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date()) {
      await giftCard.update({ status: GiftCardStatus.EXPIRED });
      throw new BadRequestException("This gift card has expired");
    }

    // Redemption requires the card to be claimed by THIS customer. Previously an
    // unassigned (customerId === null) card short-circuited this check, so anyone
    // who knew or guessed a public code could spend it. Claiming is the gate:
    // POST /promotions/gift-cards/claim assigns ownership.
    if (!giftCard.customerId) {
      await this.recordFailedAttempt(giftCard);
      throw new BadRequestException("Claim this gift card to your account before using it");
    }
    if (giftCard.customerId !== customerId) {
      await this.recordFailedAttempt(giftCard);
      throw new BadRequestException("This gift card is assigned to another customer");
    }

    if (Number(giftCard.balance) <= 0) {
      throw new BadRequestException("This gift card has zero balance");
    }

    if (giftCard.rules) {
      const rules = giftCard.rules as any;
      if (rules.minOrderValue && subtotal < rules.minOrderValue) {
        throw new BadRequestException(`Minimum order value of ${rules.minOrderValue} required`);
      }
      
      if (cartItems && cartItems.length > 0) {
        if (rules.allowedShops && rules.allowedShops.length > 0) {
          const hasValidShop = cartItems.some(item => rules.allowedShops.includes(item.shopId));
          if (!hasValidShop) throw new BadRequestException("This gift card is not valid for the shops in your cart");
        }
        if (rules.allowedCategories && rules.allowedCategories.length > 0) {
          const hasValidCategory = cartItems.some(item => rules.allowedCategories.includes(item.categoryId));
          if (!hasValidCategory) throw new BadRequestException("This gift card is not valid for the categories in your cart");
        }
        if (rules.allowedProducts && rules.allowedProducts.length > 0) {
          const hasValidProduct = cartItems.some(item => rules.allowedProducts.includes(item.productId));
          if (!hasValidProduct) throw new BadRequestException("This gift card is not valid for the products in your cart");
        }
        if (rules.allowedBrands && rules.allowedBrands.length > 0) {
          const hasValidBrand = cartItems.some(item => rules.allowedBrands.includes(item.brandId));
          if (!hasValidBrand) throw new BadRequestException("This gift card is not valid for the brands in your cart");
        }
      }
    }

    // Reset failed attempts on successful validation
    if (giftCard.failedAttempts > 0) {
      await giftCard.update({ failedAttempts: 0 });
    }

    return giftCard;
  }

  private async recordFailedAttempt(giftCard: GiftCard) {
    const attempts = giftCard.failedAttempts + 1;
    if (attempts >= 5) {
      await giftCard.update({ failedAttempts: attempts, status: GiftCardStatus.DISABLED });
      this.eventEmitter.emit("admin.notify", {
        eventType: "GIFT_CARD_FRAUD_ATTEMPT",
        variables: { giftCardId: giftCard.id, code: giftCard.code },
      });
      this.logger.warn(`Gift card ${giftCard.code} locked due to multiple failed validation attempts.`);
    } else {
      await giftCard.update({ failedAttempts: attempts });
    }
  }

  // Called strictly inside an existing transaction in orders.service.ts
  async deductBalance(giftCardId: string, amount: number, orderId: string, customerId: string, t: Transaction): Promise<void> {
    const giftCard = await this.giftCardModel.findByPk(giftCardId, { lock: t.LOCK.UPDATE, transaction: t });
    
    if (!giftCard) throw new NotFoundException("Gift card not found");
    if (giftCard.status !== GiftCardStatus.ACTIVE) throw new BadRequestException(`Gift card is ${giftCard.status}`);
    if (Number(giftCard.balance) < amount) {
      throw new BadRequestException("Insufficient gift card balance");
    }

    const newBalance = Number(giftCard.balance) - amount;

    await giftCard.update(
      { balance: newBalance },
      { transaction: t }
    );

    await this.transactionModel.create(
      {
        giftCardId: giftCard.id,
        type: "redemption",
        amount: -amount,
        balanceAfter: newBalance,
        orderId,
        customerId,
        actorId: customerId,
        notes: `Redeemed for order`,
      } as any,
      { transaction: t }
    );
    
    // Check if fully redeemed
    if (newBalance === 0) {
       await giftCard.update({ status: GiftCardStatus.DISABLED }, { transaction: t });
       await this.transactionModel.create({
          giftCardId: giftCard.id,
          type: "status_change",
          amount: 0,
          balanceAfter: 0,
          actorId: customerId,
          statusTransition: GiftCardStatus.DISABLED,
          notes: "Fully redeemed"
       } as any, { transaction: t });
    }

    t.afterCommit(() => {
      this.eventEmitter.emit("admin.notify", {
        eventType: "GIFT_CARD_REDEEMED",
        variables: { giftCardId: giftCard.id, orderId, amount },
      });
      this.trackingGateway.emitToAdmins("dashboard.giftcard_updated", { id: giftCard.id, action: "redeemed" });

      if (newBalance < 100 && newBalance > 0 && giftCard.customerId) {
        this.queueService.enqueue(giftCard.customerId, "GIFT_CARD_LOW_BALANCE" as any, { 
           code: giftCard.code, 
           balance: newBalance 
        });
      }
      
      if (giftCard.customerId) {
        this.queueService.enqueue(giftCard.customerId, "GIFT_CARD_REDEEMED" as any, { 
           amount, 
           balance: newBalance 
        });
        this.trackingGateway.emitToUser(giftCard.customerId, "wallet.updated", { giftCardId: giftCard.id, balance: newBalance });
      }
    });
  }

  // Called when an order is cancelled or payment fails (inside a transaction)
  async refundBalance(giftCardId: string, amount: number, orderId: string, actorId: string, reason: string, t: Transaction): Promise<void> {
    const giftCard = await this.giftCardModel.findByPk(giftCardId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!giftCard) return;

    const newBalance = Number(giftCard.balance) + Number(amount);

    // Reactivate if it was fully redeemed
    let newStatus = giftCard.status;
    if (giftCard.status === GiftCardStatus.DISABLED && newBalance > 0) {
      newStatus = GiftCardStatus.ACTIVE;
    }

    await giftCard.update(
      { balance: newBalance, status: newStatus },
      { transaction: t }
    );

    await this.transactionModel.create(
      {
        giftCardId: giftCard.id,
        type: "refund",
        amount: amount,
        balanceAfter: newBalance,
        orderId,
        actorId,
        statusTransition: giftCard.status !== newStatus ? newStatus : null,
        notes: reason,
      } as any,
      { transaction: t }
    );

    t.afterCommit(() => {
      this.eventEmitter.emit("admin.notify", {
        eventType: "GIFT_CARD_REFUNDED",
        variables: { giftCardId: giftCard.id, orderId, amount },
      });
      this.trackingGateway.emitToAdmins("dashboard.giftcard_updated", { id: giftCard.id, action: "refunded" });
      
      if (giftCard.customerId) {
         this.queueService.enqueue(giftCard.customerId, "GIFT_CARD_REFUNDED" as any, { 
            code: giftCard.code, 
            amount,
            newBalance
         });
         this.trackingGateway.emitToUser(giftCard.customerId, "wallet.updated", { giftCardId: giftCard.id, balance: newBalance });
      }
    });
  }

  // NB: the return must NOT contain a `success` key — ResponseInterceptor passes
  // any such object through unwrapped, so the client's `data` envelope (and thus
  // the whole payload) would come back undefined.
  async bulkUpdateStatus(ids: string[], status: GiftCardStatus, actorId: string, notes?: string): Promise<{ updated: number; skipped: number }> {
    return this.sequelize.transaction(async (t) => {
      const cards = await this.giftCardModel.findAll({ where: { id: ids }, lock: t.LOCK.UPDATE, transaction: t });

      let changed = 0;
      let skipped = 0;
      const now = new Date();

      for (const card of cards) {
        const before = card.toJSON();
        // No-op: already in the target status.
        if (before.status === status) { skipped++; continue; }

        // An expired card cannot be re-activated — it would read "Active" in the
        // UI but still fail at redemption (validateForCart re-expires it).
        // Extending the expiry date is the correct way to revive one.
        const isExpired = card.status === GiftCardStatus.EXPIRED
          || (card.expiresAt != null && new Date(card.expiresAt) < now);
        if (status === GiftCardStatus.ACTIVE && isExpired) { skipped++; continue; }

        await card.update({ status, updatedBy: actorId }, { transaction: t });
        changed++;

        await this.transactionModel.create({
          giftCardId: card.id,
          type: "status_change",
          amount: 0,
          balanceAfter: card.balance,
          actorId,
          notes: notes || `Bulk status update to ${status}`,
          statusTransition: status,
        } as any, { transaction: t });

        await this.auditLogModel.create({
          actorId,
          action: "BULK_UPDATE_STATUS",
          entity: "GiftCard",
          entityId: card.id,
          before,
          after: card.toJSON(),
        } as any, { transaction: t });
      }
      
      t.afterCommit(() => {
        this.eventEmitter.emit("admin.notify", {
          eventType: "GIFT_CARD_BULK_UPDATED",
          variables: { count: changed, status },
        });
        this.trackingGateway.emitToAdmins("dashboard.giftcard_updated", { action: "bulk_updated" });
      });

      // `updated` is what actually changed — no-ops and expired-activations are skipped.
      return { updated: changed, skipped };
    });
  }

  // NB: the return must NOT contain a `success` key — ResponseInterceptor passes
  // any such object through unwrapped, so the client's `data` envelope (and thus
  // the whole payload) would come back undefined. Mirrors bulkUpdateStatus.
  async bulkRecharge(payloads: { id: string; amount: number }[], actorId: string, notes?: string): Promise<{ recharged: number; skipped: number }> {
    return this.sequelize.transaction(async (t) => {
      const ids = payloads.map(p => p.id);
      const cards = await this.giftCardModel.findAll({ where: { id: ids }, lock: t.LOCK.UPDATE, transaction: t });

      let recharged = 0;
      let skipped = 0;

      for (const card of cards) {
        if (card.status !== GiftCardStatus.ACTIVE) { skipped++; continue; }
        const p = payloads.find(x => x.id === card.id);
        if (!p || p.amount <= 0) { skipped++; continue; }

        const newBalance = Number(card.balance) + Number(p.amount);
        recharged++;
        await card.update({ balance: newBalance, updatedBy: actorId }, { transaction: t });

        await this.transactionModel.create({
          giftCardId: card.id,
          type: "recharge",
          amount: p.amount,
          balanceAfter: newBalance,
          actorId,
          notes: notes || "Bulk recharge",
        } as any, { transaction: t });

        await this.auditLogModel.create({
          actorId,
          action: "BULK_RECHARGE",
          entity: "GiftCard",
          entityId: card.id,
          after: card.toJSON(),
        } as any, { transaction: t });
      }

      t.afterCommit(() => {
        this.eventEmitter.emit("admin.notify", {
          eventType: "GIFT_CARD_BULK_RECHARGED",
          variables: { count: recharged },
        });
        this.trackingGateway.emitToAdmins("dashboard.giftcard_updated", { action: "bulk_recharged" });
      });

      // `recharged` is what actually changed — inactive cards and non-positive
      // amounts are skipped, so cards.length would overreport.
      return { recharged, skipped };
    });
  }
}
