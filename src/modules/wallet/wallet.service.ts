import { Injectable, Logger } from "@nestjs/common";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { Transaction, Op, literal } from "sequelize";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CustomerWallet, WalletTransaction, AuditLog } from "@/models";
import { WalletTxnType, WalletCategory } from "@/models/wallet.model";
import { BadRequestException } from "@/common/errors/http";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate } from "@/common/utils/crud.util";

/** Metadata for a wallet movement (amount and direction are passed separately). */
export interface WalletMeta {
  orderId?: string | null;
  returnId?: string | null;
  giftCardId?: string | null;
  actorId?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
  category?: WalletCategory | null;
  /** Credit bucket expiry (null = never). Or provide `expiresInDays`. */
  expiresAt?: Date | null;
  expiresInDays?: number | null;
}

/**
 * Customer wallet ledger (REFUND_WALLET_POLICY_WORKFLOW §8). Every credit is a
 * FIFO-by-expiry "bucket" (`remainingAmount`); debits draw from buckets
 * expiring-soonest-first (then promotional before refund/manual). Expired unspent
 * credits are swept daily and are never spendable. `CustomerWallet.balance` is the
 * cached spendable total; `getBalance` returns balance minus any expired-unswept credit.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger("WalletService");

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @InjectModel(CustomerWallet) private readonly wallets: typeof CustomerWallet,
    @InjectModel(WalletTransaction) private readonly txns: typeof WalletTransaction,
    @InjectModel(AuditLog) private readonly auditLog: typeof AuditLog,
  ) {}

  private round2(n: number): number { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  private resolveExpiry(m: WalletMeta): Date | null {
    if (m.expiresAt) return m.expiresAt;
    if (m.expiresInDays && m.expiresInDays > 0) return new Date(Date.now() + m.expiresInDays * 24 * 3600 * 1000);
    return null;
  }

  /** FIFO ordering: expiring-soonest first, then promotional (CASHBACK/BONUS) before REFUND/GIFT_CARD before MANUAL_CREDIT/other. */
  private readonly bucketOrder: any = [
    [literal('"expiresAt" IS NULL'), "ASC"], // non-null (expiring) first
    ["expiresAt", "ASC"],                     // soonest first
    [literal(`CASE "category" WHEN 'CASHBACK' THEN 0 WHEN 'BONUS' THEN 0 WHEN 'REFUND' THEN 1 WHEN 'GIFT_CARD' THEN 1 ELSE 2 END`), "ASC"],
    ["createdAt", "ASC"],
  ];

  async getOrCreate(userId: string, t?: Transaction): Promise<CustomerWallet> {
    const [wallet] = await this.wallets.findOrCreate({
      where: { userId },
      defaults: { userId, balance: 0, currency: "INR" } as any,
      ...(t ? { transaction: t, lock: t.LOCK.UPDATE } : {}),
    });
    return wallet;
  }

  /** Sum of expired-but-unswept credit buckets for a wallet — excluded from spendable balance. */
  private async expiredUnspent(walletId: string, t?: Transaction): Promise<number> {
    const rows = await this.txns.findAll({
      where: { walletId, expiresAt: { [Op.lt]: new Date() }, remainingAmount: { [Op.gt]: 0 } },
      attributes: ["remainingAmount"], transaction: t,
    });
    return this.round2(rows.reduce((s, r) => s + Number(r.remainingAmount || 0), 0));
  }

  async getBalance(userId: string): Promise<{ balance: number; currency: string }> {
    const wallet = await this.getOrCreate(userId);
    const spendable = this.round2(Math.max(0, Number(wallet.balance) - (await this.expiredUnspent(wallet.id))));
    return { balance: spendable, currency: wallet.currency };
  }

  async listTransactions(userId: string, opts: PageOptionsDto) {
    return paginate(this.txns, opts, { userId }, [], { order: [["createdAt", "DESC"]] });
  }

  /** Add funds (credit / refund / cashback / bonus / manual). Each credit becomes a FIFO bucket. */
  async credit(userId: string, amount: number, m: WalletMeta & { type?: WalletTxnType } = {}, t?: Transaction) {
    if (!(amount > 0)) throw new BadRequestException("VALIDATION_FAILED", "Amount must be greater than 0");
    amount = this.round2(amount);
    const run = async (tx: Transaction) => {
      if (m.idempotencyKey) {
        const dup = await this.txns.findOne({ where: { idempotencyKey: m.idempotencyKey }, transaction: tx });
        if (dup) return this.getOrCreate(userId, tx);
      }
      const wallet = await this.getOrCreate(userId, tx);
      const newBalance = this.round2(Number(wallet.balance) + amount);
      await wallet.update({ balance: newBalance }, { transaction: tx });
      await this.txns.create({
        walletId: wallet.id, userId, type: m.type ?? "credit", category: m.category ?? null,
        amount, remainingAmount: amount, expiresAt: this.resolveExpiry(m),
        balanceAfter: newBalance, orderId: m.orderId ?? null, returnId: m.returnId ?? null,
        giftCardId: m.giftCardId ?? null, actorId: m.actorId ?? null,
        reason: m.reason ?? null, idempotencyKey: m.idempotencyKey ?? null,
      } as any, { transaction: tx });
      if (m.actorId) await this.writeAudit(m.actorId, wallet.id, "WALLET_CREDIT", { amount, category: m.category ?? null, reason: m.reason ?? null }, tx);
      return wallet;
    };
    return t ? run(t) : this.sequelize.transaction(run);
  }

  /** Remove funds (debit). FIFO-consumes live credit buckets; blocks if spendable balance is insufficient. */
  async debit(userId: string, amount: number, m: WalletMeta = {}, t?: Transaction) {
    if (!(amount > 0)) throw new BadRequestException("VALIDATION_FAILED", "Amount must be greater than 0");
    amount = this.round2(amount);
    const run = async (tx: Transaction) => {
      const wallet = await this.getOrCreate(userId, tx);
      const spendable = this.round2(Number(wallet.balance) - (await this.expiredUnspent(wallet.id, tx)));
      if (spendable < amount) throw new BadRequestException("VALIDATION_FAILED", "Insufficient wallet balance");

      // FIFO: draw from live (unexpired) buckets, expiring-soonest first.
      const buckets = await this.txns.findAll({
        where: {
          walletId: wallet.id, remainingAmount: { [Op.gt]: 0 },
          [Op.or]: [{ expiresAt: null as any }, { expiresAt: { [Op.gt]: new Date() } }],
        },
        order: this.bucketOrder, lock: tx.LOCK.UPDATE, transaction: tx,
      });
      let toConsume = amount;
      for (const b of buckets) {
        if (toConsume <= 0) break;
        const take = Math.min(Number(b.remainingAmount), toConsume);
        await b.update({ remainingAmount: this.round2(Number(b.remainingAmount) - take) }, { transaction: tx });
        toConsume = this.round2(toConsume - take);
      }
      // Any leftover is drawn from the untracked opening balance (pre-Phase-2 credits) — no bucket to reduce.

      const newBalance = this.round2(Number(wallet.balance) - amount);
      await wallet.update({ balance: newBalance }, { transaction: tx });
      await this.txns.create({
        walletId: wallet.id, userId, type: "debit", category: m.category ?? null, amount,
        balanceAfter: newBalance, orderId: m.orderId ?? null, returnId: m.returnId ?? null,
        actorId: m.actorId ?? null, reason: m.reason ?? null, idempotencyKey: m.idempotencyKey ?? null,
      } as any, { transaction: tx });
      if (m.actorId) await this.writeAudit(m.actorId, wallet.id, "WALLET_DEBIT", { amount, reason: m.reason ?? null }, tx);
      return wallet;
    };
    return t ? run(t) : this.sequelize.transaction(run);
  }

  private async writeAudit(actorId: string, walletId: string, action: string, after: any, t: Transaction) {
    await this.auditLog.create({ actorId, action, entity: "CustomerWallet", entityId: walletId, after } as any, { transaction: t });
  }

  /** Sweep expired unspent credit buckets across all wallets: zero the bucket, write an EXPIRY debit, reduce balance. */
  async sweepExpiredCredits(): Promise<{ wallets: number; total: number }> {
    return this.sequelize.transaction(async (tx) => {
      const expired = await this.txns.findAll({
        where: { expiresAt: { [Op.lt]: new Date() }, remainingAmount: { [Op.gt]: 0 } },
        lock: tx.LOCK.UPDATE, transaction: tx,
      });
      const byWallet = new Map<string, WalletTransaction[]>();
      for (const b of expired) {
        const arr = byWallet.get(b.walletId) ?? [];
        arr.push(b); byWallet.set(b.walletId, arr);
      }
      let total = 0;
      for (const [walletId, buckets] of byWallet) {
        const wallet = await this.wallets.findByPk(walletId, { lock: tx.LOCK.UPDATE, transaction: tx });
        if (!wallet) continue;
        let sum = 0;
        for (const b of buckets) { sum += Number(b.remainingAmount || 0); await b.update({ remainingAmount: 0 }, { transaction: tx }); }
        sum = this.round2(sum);
        const newBalance = this.round2(Math.max(0, Number(wallet.balance) - sum));
        await wallet.update({ balance: newBalance }, { transaction: tx });
        await this.txns.create({
          walletId, userId: wallet.userId, type: "debit", category: "EXPIRY", amount: sum,
          balanceAfter: newBalance, reason: "Expired wallet credits",
        } as any, { transaction: tx });
        total = this.round2(total + sum);
      }
      return { wallets: byWallet.size, total };
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async expiryCron() {
    try {
      const r = await this.sweepExpiredCredits();
      if (r.total > 0) this.logger.log(`Wallet expiry sweep: expired ₹${r.total} across ${r.wallets} wallet(s)`);
    } catch (e) {
      this.logger.error("Wallet expiry sweep failed", e as any);
    }
  }

  /** Admin/staff read of a specific customer's wallet + recent history. */
  async adminView(userId: string, opts: PageOptionsDto) {
    const balance = await this.getBalance(userId);
    const history = await this.listTransactions(userId, opts);
    return { wallet: balance, transactions: history };
  }
}
