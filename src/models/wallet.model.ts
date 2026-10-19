import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, ForeignKey, BelongsTo, HasMany } from "sequelize-typescript";
import { User } from "./user.model";

/**
 * Customer stored-value wallet. One row per user; `balance` is the spendable
 * amount. Distinct from EarningWallet (shop/seller) and from gift cards.
 * Every change is recorded in WalletTransaction for an auditable ledger.
 */
@Table({ tableName: "customer_wallets", timestamps: true })
export class CustomerWallet extends Model<CustomerWallet> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => User)
  @Unique
  @AllowNull(false)
  @Column(DataType.UUID)
  declare userId: string;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare balance: number;

  @Default("INR")
  @Column(DataType.STRING(10))
  declare currency: string;

  @BelongsTo(() => User) declare user?: User;
  @HasMany(() => WalletTransaction) declare transactions?: WalletTransaction[];
}

export const WALLET_TXN_TYPES = ["credit", "debit", "refund", "adjustment"] as const;
export type WalletTxnType = (typeof WALLET_TXN_TYPES)[number];

/** Ledger categories (REFUND_WALLET_POLICY_WORKFLOW §8). Direction is `type`; this classifies the money. */
export const WALLET_CATEGORIES = ["REFUND", "GIFT_CARD", "CASHBACK", "BONUS", "MANUAL_CREDIT", "EXPIRY"] as const;
export type WalletCategory = (typeof WALLET_CATEGORIES)[number];

/**
 * Immutable ledger entry for a wallet change. `amount` is always positive; the
 * direction is given by `type` (credit/refund add, debit subtracts).
 * `balanceAfter` snapshots the resulting balance.
 */
@Table({ tableName: "wallet_transactions", timestamps: true })
export class WalletTransaction extends Model<WalletTransaction> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => CustomerWallet)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare walletId: string;

  // Denormalised for simple "my transactions" queries without a join.
  @AllowNull(false)
  @Column(DataType.UUID)
  declare userId: string;

  @AllowNull(false)
  @Column(DataType.ENUM(...WALLET_TXN_TYPES))
  declare type: WalletTxnType;

  @AllowNull(false)
  @Column(DataType.DECIMAL(12, 2))
  declare amount: number;

  @AllowNull(false)
  @Column(DataType.DECIMAL(12, 2))
  declare balanceAfter: number;

  @Column(DataType.UUID)
  declare orderId: string | null;

  // Admin/actor who performed a manual credit/debit, when applicable.
  @Column(DataType.UUID)
  declare actorId: string | null;

  @Column(DataType.STRING(300))
  declare reason: string | null;

  @Column(DataType.STRING(120))
  declare idempotencyKey: string | null;

  // ── Ledger categories + expiry buckets (§8) ──
  @Column(DataType.STRING(30)) declare category: string | null;             // REFUND | GIFT_CARD | CASHBACK | BONUS | MANUAL_CREDIT | EXPIRY
  @Column(DataType.DATE) declare expiresAt: Date | null;                    // credit bucket expiry (null = never)
  @Column(DataType.DECIMAL(12, 2)) declare remainingAmount: number | null; // unspent balance of a credit bucket (FIFO)
  @Column(DataType.UUID) declare returnId: string | null;
  @Column(DataType.UUID) declare giftCardId: string | null;

  @BelongsTo(() => CustomerWallet) declare wallet?: CustomerWallet;
}
