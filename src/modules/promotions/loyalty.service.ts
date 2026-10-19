import { Injectable, Logger, NotFoundException, BadRequestException, Inject, forwardRef } from "@nestjs/common";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize, Transaction } from "sequelize";
import { Op } from "sequelize";
import { LoyaltyAccount, LoyaltyTransaction, AuditLog, Setting } from "@/models";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { NotificationQueueService } from "../notifications/notification.queue";
import { NotificationEventType } from "@/common/enums/notification-event.enum";

/** Resolved loyalty configuration (Settings-driven, with production defaults). */
interface LoyaltyConfig {
  earnRate: number;      // ₹ spend per 1 base point (before tier multiplier)
  pointValue: number;    // ₹ value of 1 point when redeemed
  tiers: { silver: number; gold: number; platinum: number };
  multipliers: { bronze: number; silver: number; gold: number; platinum: number };
  expiryDays: number;    // 0 = points never expire
  reminderDays: number;  // pre-expiry reminder window
}

/** A positive points "lot" with the amount still unspent (FIFO). */
interface Lot { id: string; remaining: number; expiresAt: Date | null; expiredAt: Date | null; }

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger("LoyaltyService");

  constructor(
    @InjectConnection() private sequelize: Sequelize,
    @InjectModel(LoyaltyAccount) private loyaltyAccountModel: typeof LoyaltyAccount,
    @InjectModel(LoyaltyTransaction) private transactionModel: typeof LoyaltyTransaction,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    @InjectModel(Setting) private settingModel: typeof Setting,
    private eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => NotificationQueueService))
    private queueService: NotificationQueueService,
  ) {}

  /* ───────────────────────── Config ───────────────────────── */

  /** Read all `loyalty.*` settings once, applying production defaults per key. */
  private async loadConfig(): Promise<LoyaltyConfig> {
    const rows = await this.settingModel.findAll({ where: { key: { [Op.like]: "loyalty.%" } } });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const num = (key: string, fallback: number): number => {
      const v = map.get(key) as unknown;
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      earnRate: num("loyalty.earnRate", 100),
      pointValue: num("loyalty.pointValue", 0.1),
      tiers: {
        silver: num("loyalty.tier.silver", 1000),
        gold: num("loyalty.tier.gold", 5000),
        platinum: num("loyalty.tier.platinum", 10000),
      },
      multipliers: {
        bronze: num("loyalty.multiplier.bronze", 1.0),
        silver: num("loyalty.multiplier.silver", 1.25),
        gold: num("loyalty.multiplier.gold", 1.5),
        platinum: num("loyalty.multiplier.platinum", 2.0),
      },
      expiryDays: num("loyalty.expiryDays", 365),
      reminderDays: num("loyalty.reminderDays", 30),
    };
  }

  /** Public config for customer UI (tier thresholds, multipliers, conversion). */
  async getPublicConfig() {
    const cfg = await this.loadConfig();
    return { tiers: cfg.tiers, multipliers: cfg.multipliers, pointValue: cfg.pointValue, expiryDays: cfg.expiryDays };
  }

  private calculateTier(lifetimePoints: number, cfg: LoyaltyConfig): string {
    if (lifetimePoints >= cfg.tiers.platinum) return "platinum";
    if (lifetimePoints >= cfg.tiers.gold) return "gold";
    if (lifetimePoints >= cfg.tiers.silver) return "silver";
    return "bronze";
  }

  private getMultiplier(tier: string, cfg: LoyaltyConfig): number {
    return (cfg.multipliers as any)[tier] ?? 1.0;
  }

  /* ───────────────────────── Earn ───────────────────────── */

  async earnPoints(userId: string, orderId: string, orderTotal: number, t?: Transaction): Promise<LoyaltyAccount> {
    const runInTransaction = async (transaction: Transaction) => {
      const cfg = await this.loadConfig();
      let [account] = await this.loyaltyAccountModel.findOrCreate({
        where: { userId },
        defaults: { userId, pointsBalance: 0, lifetimePoints: 0, tier: "bronze" } as any,
        transaction,
        lock: transaction.LOCK.UPDATE
      });

      // Reload to ensure we lock it properly if findOrCreate just found it
      account = (await this.loyaltyAccountModel.findByPk(account.id, { lock: transaction.LOCK.UPDATE, transaction })) as LoyaltyAccount;

      // Idempotency: never earn twice for the same order (payment retry / webhook replay)
      const alreadyEarned = await this.transactionModel.findOne({
        where: { orderId, reason: ["earn", "order_earn"] },
        transaction
      });
      if (alreadyEarned) return account;

      const basePoints = cfg.earnRate > 0 ? Math.floor(orderTotal / cfg.earnRate) : 0;
      if (basePoints <= 0) return account;

      const multiplier = this.getMultiplier(account.tier, cfg);
      const pointsToEarn = Math.floor(basePoints * multiplier);

      const oldTier = account.tier;
      const newBalance = Number(account.pointsBalance) + pointsToEarn;
      const newLifetime = Number(account.lifetimePoints) + pointsToEarn;
      const newTier = this.calculateTier(newLifetime, cfg);
      const expiresAt = cfg.expiryDays > 0 ? new Date(Date.now() + cfg.expiryDays * 86400000) : null;

      await account.update({
        pointsBalance: newBalance,
        lifetimePoints: newLifetime,
        tier: newTier
      }, { transaction });

      await this.transactionModel.create({
        accountId: account.id,
        points: pointsToEarn,
        reason: "earn",
        orderId,
        expiresAt,
      } as any, { transaction });

      transaction.afterCommit(() => {
        this.queueService.enqueue(userId, NotificationEventType.LOYALTY_POINTS_ISSUED, { points: pointsToEarn, newBalance, orderId });
        if (oldTier !== newTier) {
          this.queueService.enqueue(userId, NotificationEventType.LOYALTY_TIER_UPGRADED, { oldTier, newTier });
        }
      });

      return account;
    };

    if (t) {
      return runInTransaction(t);
    }
    return this.sequelize.transaction(runInTransaction);
  }

  /* ───────────────────────── Redeem / Refund ───────────────────────── */

  // Deduct points during checkout
  async redeemPoints(userId: string, pointsToRedeem: number, orderId: string, t: Transaction): Promise<void> {
    const account = await this.loyaltyAccountModel.findOne({
      where: { userId },
      lock: t.LOCK.UPDATE,
      transaction: t
    });

    if (!account) throw new NotFoundException("Loyalty account not found");
    if (Number(account.pointsBalance) < pointsToRedeem) {
      throw new BadRequestException("Insufficient loyalty points");
    }

    const newBalance = Number(account.pointsBalance) - pointsToRedeem;

    await account.update({ pointsBalance: newBalance }, { transaction: t });

    await this.transactionModel.create({
      accountId: account.id,
      points: -pointsToRedeem,
      reason: "redeem",
      orderId
    } as any, { transaction: t });

    t.afterCommit(() => {
      this.queueService.enqueue(userId, NotificationEventType.LOYALTY_POINTS_REDEEMED, { points: pointsToRedeem, newBalance, orderId });
    });
  }

  // Points a user has available to redeem (0 if no account). Locks the row when
  // called inside the checkout transaction so the amount can't be double-spent.
  async getAvailablePoints(userId: string, t?: Transaction): Promise<number> {
    const account = await this.loyaltyAccountModel.findOne({
      where: { userId },
      ...(t ? { lock: t.LOCK.UPDATE, transaction: t } : {})
    });
    return account ? Number(account.pointsBalance) : 0;
  }

  // Restore points that were redeemed for an order (cancel/return). Looks up the
  // redeem tx and is idempotent — a prior refund row short-circuits it.
  async refundRedeemedPoints(userId: string, orderId: string, t: Transaction): Promise<void> {
    const redeemTx = await this.transactionModel.findOne({
      where: { orderId, reason: "redeem" },
      transaction: t
    });
    if (!redeemTx) return;

    const alreadyRefunded = await this.transactionModel.findOne({
      where: { orderId, reason: "refund" },
      transaction: t
    });
    if (alreadyRefunded) return;

    await this.refundPoints(userId, Math.abs(Number(redeemTx.points)), orderId, t);
  }

  // Restore points on order cancellation
  async refundPoints(userId: string, pointsToRestore: number, orderId: string, t: Transaction): Promise<void> {
    const account = await this.loyaltyAccountModel.findOne({
      where: { userId },
      lock: t.LOCK.UPDATE,
      transaction: t
    });

    if (!account) return;

    const newBalance = Number(account.pointsBalance) + pointsToRestore;

    await account.update({ pointsBalance: newBalance }, { transaction: t });

    await this.transactionModel.create({
      accountId: account.id,
      points: pointsToRestore,
      reason: "refund",
      orderId
    } as any, { transaction: t });
  }

  // Rollback points that were earned for an order (due to cancellation/timeout)
  async rollbackEarnedPoints(userId: string, orderId: string, t: Transaction): Promise<void> {
    const earnTx = await this.transactionModel.findOne({
      where: { orderId, reason: ["earn", "order_earn"] },
      transaction: t
    });

    if (!earnTx) return;

    const account = await this.loyaltyAccountModel.findOne({
      where: { userId },
      lock: t.LOCK.UPDATE,
      transaction: t
    });

    if (!account) return;

    const cfg = await this.loadConfig();
    const pointsToRollback = Number(earnTx.points);
    const newBalance = Math.max(0, Number(account.pointsBalance) - pointsToRollback);
    const newLifetime = Math.max(0, Number(account.lifetimePoints) - pointsToRollback);
    const newTier = this.calculateTier(newLifetime, cfg);

    await account.update({
      pointsBalance: newBalance,
      lifetimePoints: newLifetime,
      tier: newTier
    }, { transaction: t });

    await this.transactionModel.create({
      accountId: account.id,
      points: -pointsToRollback,
      reason: "rollback_earn",
      orderId
    } as any, { transaction: t });
  }

  /**
   * Proportional clawback of EARNED points when part of an order is returned/refunded.
   * Reverses `earned × (refundedAmount / orderTotal)`, capped cumulatively so multiple
   * partial returns of the same order never claw back more than was earned. Reduces
   * lifetimePoints too (a returned purchase shouldn't count toward tier). Self-transacts
   * when no `t` is supplied.
   */
  async clawbackForReturn(userId: string, orderId: string, returnedValue: number, orderValue: number, t?: Transaction): Promise<void> {
    const run = async (tx: Transaction) => {
      const account = await this.loyaltyAccountModel.findOne({ where: { userId }, lock: tx.LOCK.UPDATE, transaction: tx });
      if (!account) return;

      const earnTx = await this.transactionModel.findOne({ where: { orderId, reason: ["earn", "order_earn"] }, transaction: tx });
      if (!earnTx) return;
      const earned = Number(earnTx.points);
      if (earned <= 0) return;

      // Reverse earned points proportional to the returned goods VALUE / order value (§4.3).
      const proportion = orderValue > 0 ? Math.min(1, Math.max(0, returnedValue / orderValue)) : 0;
      const target = Math.floor(earned * proportion);

      const priorSum = (await this.transactionModel.sum("points", { where: { orderId, reason: "return_clawback" }, transaction: tx })) || 0;
      const alreadyClawed = Math.abs(Number(priorSum));
      const deduct = Math.min(target, earned - alreadyClawed);
      if (deduct <= 0) return;

      const cfg = await this.loadConfig();
      const newBalance = Math.max(0, Number(account.pointsBalance) - deduct);
      const newLifetime = Math.max(0, Number(account.lifetimePoints) - deduct);
      const newTier = this.calculateTier(newLifetime, cfg);

      await account.update({ pointsBalance: newBalance, lifetimePoints: newLifetime, tier: newTier }, { transaction: tx });
      await this.transactionModel.create({ accountId: account.id, points: -deduct, reason: "return_clawback", orderId } as any, { transaction: tx });
    };

    if (t) return run(t);
    await this.sequelize.transaction(run);
  }

  /* ───────────────────────── Admin ───────────────────────── */

  async manualAdjustment(adminId: string, userId: string, points: number, reason: string): Promise<LoyaltyAccount> {
    return this.sequelize.transaction(async (t) => {
      const cfg = await this.loadConfig();
      const account = await this.loyaltyAccountModel.findOne({
        where: { userId },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!account) throw new NotFoundException("Loyalty account not found");

      const before = account.toJSON();
      const newBalance = Math.max(0, Number(account.pointsBalance) + points);
      const newLifetime = points > 0 ? Number(account.lifetimePoints) + points : Number(account.lifetimePoints);
      const newTier = this.calculateTier(newLifetime, cfg);
      // Positive adjustments are treated as an earned lot so they can expire like earned points.
      const expiresAt = points > 0 && cfg.expiryDays > 0 ? new Date(Date.now() + cfg.expiryDays * 86400000) : null;

      await account.update({
        pointsBalance: newBalance,
        lifetimePoints: newLifetime,
        tier: newTier
      }, { transaction: t });

      await this.transactionModel.create({
        accountId: account.id,
        points: points,
        reason: "adjustment",
        expiresAt,
      } as any, { transaction: t });

      await this.auditLogModel.create({
        actorId: adminId,
        action: "LOYALTY_ADJUSTMENT",
        entity: "LoyaltyAccount",
        entityId: account.id,
        before,
        after: account.toJSON()
      } as any, { transaction: t });

      return account;
    });
  }

  /* ───────────────────────── Expiry (FIFO lots) ───────────────────────── */

  /**
   * Reconstruct per-lot remaining balances by replaying the ledger FIFO: every
   * positive row is a lot; every negative row consumes the oldest lots first.
   */
  private async computeLots(accountId: string, t?: Transaction): Promise<Lot[]> {
    const txns = await this.transactionModel.findAll({
      where: { accountId },
      order: [["createdAt", "ASC"], ["id", "ASC"]],
      ...(t ? { transaction: t, lock: t.LOCK.UPDATE } : {}),
    });
    const lots: Lot[] = [];
    for (const tx of txns) {
      const pts = Number(tx.points);
      if (pts > 0) {
        lots.push({
          id: tx.id,
          remaining: pts,
          expiresAt: tx.expiresAt ? new Date(tx.expiresAt) : null,
          expiredAt: tx.expiredAt ? new Date(tx.expiredAt) : null,
        });
      } else if (pts < 0) {
        let consume = -pts;
        for (const lot of lots) {
          if (consume <= 0) break;
          if (lot.remaining <= 0) continue;
          const take = Math.min(lot.remaining, consume);
          lot.remaining -= take;
          consume -= take;
        }
      }
    }
    return lots;
  }

  /** Points that will expire for a user within `withinDays` (default = reminder window). */
  async getExpiringPoints(userId: string, withinDays?: number): Promise<{ points: number; expiresAt: string | null }> {
    const account = await this.loyaltyAccountModel.findOne({ where: { userId } });
    if (!account) return { points: 0, expiresAt: null };
    const cfg = await this.loadConfig();
    if (cfg.expiryDays <= 0) return { points: 0, expiresAt: null };
    const days = withinDays ?? cfg.reminderDays;
    const now = new Date();
    const horizon = new Date(now.getTime() + days * 86400000);
    const lots = await this.computeLots(account.id);
    let points = 0;
    let soonest: Date | null = null;
    for (const lot of lots) {
      if (lot.expiresAt && !lot.expiredAt && lot.remaining > 0 && lot.expiresAt > now && lot.expiresAt <= horizon) {
        points += lot.remaining;
        if (!soonest || lot.expiresAt < soonest) soonest = lot.expiresAt;
      }
    }
    return { points, expiresAt: soonest ? soonest.toISOString().slice(0, 10) : null };
  }

  /** Expire one account's due lots (row-locked); returns what was expired. */
  private async expireForAccount(accountId: string, now: Date, t: Transaction): Promise<{ userId: string; expired: number; newBalance: number }> {
    const account = await this.loyaltyAccountModel.findByPk(accountId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!account) return { userId: "", expired: 0, newBalance: 0 };

    const lots = await this.computeLots(accountId, t);
    let totalExpire = 0;
    const toStamp: string[] = [];
    for (const lot of lots) {
      if (lot.expiresAt && lot.expiresAt < now && !lot.expiredAt) {
        toStamp.push(lot.id);
        if (lot.remaining > 0) totalExpire += lot.remaining;
      }
    }
    if (toStamp.length) {
      await this.transactionModel.update({ expiredAt: now }, { where: { id: toStamp }, transaction: t });
    }
    let newBalance = Number(account.pointsBalance);
    if (totalExpire > 0) {
      newBalance = Math.max(0, newBalance - totalExpire);
      await account.update({ pointsBalance: newBalance }, { transaction: t });
      await this.transactionModel.create({ accountId, points: -totalExpire, reason: "expiry" } as any, { transaction: t });
    }
    return { userId: account.userId, expired: totalExpire, newBalance };
  }

  /**
   * Daily sweep: expire due points and send pre-expiry reminders. Idempotent —
   * expired lots are stamped `expiredAt`, reminded lots are stamped `reminderSentAt`.
   */
  async expireDuePoints(): Promise<{ accountsProcessed: number; pointsExpired: number; remindersSent: number }> {
    const cfg = await this.loadConfig();
    if (cfg.expiryDays <= 0) return { accountsProcessed: 0, pointsExpired: 0, remindersSent: 0 };
    const now = new Date();
    let pointsExpired = 0;
    let remindersSent = 0;

    // 1. Expire due lots.
    const dueLots = await this.transactionModel.findAll({
      // NULL expiresAt never matches `< now`, so this only picks real, due lots.
      where: { expiredAt: null, points: { [Op.gt]: 0 }, expiresAt: { [Op.lt]: now } },
      attributes: ["accountId"],
      limit: 5000,
    });
    const dueAccountIds = [...new Set(dueLots.map((l) => l.accountId))];
    for (const accountId of dueAccountIds) {
      const res = await this.sequelize.transaction((t) => this.expireForAccount(accountId, now, t));
      if (res.expired > 0) {
        pointsExpired += res.expired;
        this.queueService.enqueue(res.userId, NotificationEventType.LOYALTY_POINTS_EXPIRED, { points: res.expired, newBalance: res.newBalance });
      }
    }

    // 2. Pre-expiry reminders.
    const horizon = new Date(now.getTime() + cfg.reminderDays * 86400000);
    const reminderLots = await this.transactionModel.findAll({
      where: { expiredAt: null, reminderSentAt: null, points: { [Op.gt]: 0 }, expiresAt: { [Op.gt]: now, [Op.lte]: horizon } },
      limit: 5000,
    });
    const byAccount = new Map<string, LoyaltyTransaction[]>();
    for (const lot of reminderLots) {
      const list = byAccount.get(lot.accountId) ?? [];
      list.push(lot);
      byAccount.set(lot.accountId, list);
    }
    for (const [accountId, lots] of byAccount) {
      const account = await this.loyaltyAccountModel.findByPk(accountId);
      if (!account) continue;
      const liveLots = await this.computeLots(accountId);
      const remainingById = new Map(liveLots.map((l) => [l.id, l.remaining]));
      let points = 0;
      let soonest: Date | null = null;
      const ids: string[] = [];
      for (const lot of lots) {
        ids.push(lot.id);
        const rem = remainingById.get(lot.id) ?? 0;
        if (rem > 0 && lot.expiresAt) {
          points += rem;
          const ea = new Date(lot.expiresAt);
          if (!soonest || ea < soonest) soonest = ea;
        }
      }
      if (ids.length) await this.transactionModel.update({ reminderSentAt: now }, { where: { id: ids } });
      if (points > 0 && soonest) {
        this.queueService.enqueue(account.userId, NotificationEventType.LOYALTY_POINTS_EXPIRING, { points, expiresAt: soonest.toISOString().slice(0, 10) });
        remindersSent++;
      }
    }

    this.logger.log(`Loyalty expiry sweep: ${dueAccountIds.length} accounts, ${pointsExpired} expired, ${remindersSent} reminders.`);
    return { accountsProcessed: dueAccountIds.length, pointsExpired, remindersSent };
  }
}
