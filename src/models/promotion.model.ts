import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, HasMany, ForeignKey, BelongsTo } from "sequelize-typescript";

@Table({ tableName: "coupons", paranoid: true, timestamps: true })
export class Coupon extends Model<Coupon> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Unique @Column(DataType.STRING(40)) declare code: string;
  @AllowNull(false) @Column(DataType.ENUM("pct", "flat", "free_delivery", "bogo")) declare type: string;
  @AllowNull(false) @Column(DataType.DECIMAL(10,2)) declare value: number;
  @Default(0) @Column(DataType.DECIMAL(10,2)) declare minOrder: number;
  @Column(DataType.INTEGER) declare usageLimit: number | null;
  @Column(DataType.INTEGER) declare perUserLimit: number | null;
  @Column(DataType.DATE) declare startsAt: Date | null;
  @Column(DataType.DATE) declare expiresAt: Date | null;
  @Column(DataType.JSONB) declare rules: unknown;
  @Default(true) @Column(DataType.BOOLEAN) declare isActive: boolean;

  @Column(DataType.VIRTUAL)
  get bogoRule() {
    const r = this.getDataValue('rules') as any;
    return r?.bogo || null;
  }

  @Default(0) @Column(DataType.INTEGER) declare priority: number;
  @Default(false) @Column(DataType.BOOLEAN) declare stackable: boolean;
  @Default(false) @Column(DataType.BOOLEAN) declare firstOrderOnly: boolean;
  @Default(false) @Column(DataType.BOOLEAN) declare newCustomerOnly: boolean;
  @Default("draft") @Column(DataType.ENUM("draft", "active", "paused", "inactive", "expired")) declare status: string;

  @HasMany(() => CouponRedemption) declare redemptions?: CouponRedemption[];
  @HasMany(() => CouponHistory) declare history?: CouponHistory[];
}

@Table({ tableName: "coupon_history", timestamps: true })
export class CouponHistory extends Model<CouponHistory> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Coupon) @AllowNull(false) @Column(DataType.UUID) declare couponId: string;
  @AllowNull(false) @Column(DataType.UUID) declare actorId: string;
  
  @Column(DataType.JSONB) declare beforeValues: unknown;
  @Column(DataType.JSONB) declare afterValues: unknown;

  @BelongsTo(() => Coupon) declare coupon?: Coupon;
  @BelongsTo(() => (CouponHistory as any).sequelize?.models.User, 'actorId') declare actor?: any;
}

@Table({ tableName: "coupon_redemptions", timestamps: true })
export class CouponRedemption extends Model<CouponRedemption> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Coupon) @AllowNull(false) @Column(DataType.UUID) declare couponId: string;
  @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  @AllowNull(false) @Column(DataType.UUID) declare orderId: string;
  @Default("reserved") @Column(DataType.ENUM("reserved", "active", "cancelled")) declare status: string;
  @Default(true) @Column(DataType.BOOLEAN) declare isActive: boolean; // Retained for backwards compatibility temporarily

  @BelongsTo(() => Coupon) declare coupon?: Coupon;
}

@Table({ tableName: "loyalty_accounts", timestamps: true })
export class LoyaltyAccount extends Model<LoyaltyAccount> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Unique @Column(DataType.UUID) declare userId: string;
  @Default(0) @Column(DataType.INTEGER) declare pointsBalance: number;
  @Default(0) @Column(DataType.INTEGER) declare lifetimePoints: number;
  @Default("bronze") @Column(DataType.ENUM("bronze", "silver", "gold", "platinum")) declare tier: string;
}

@Table({ tableName: "loyalty_transactions", timestamps: true })
export class LoyaltyTransaction extends Model<LoyaltyTransaction> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.UUID) declare accountId: string;
  @AllowNull(false) @Column(DataType.INTEGER) declare points: number;
  @AllowNull(false) @Column(DataType.STRING(60)) declare reason: string;
  @Column(DataType.UUID) declare orderId: string | null;
  // When this earned lot expires (null for non-earn rows / when expiry is disabled).
  @Column(DataType.DATE) declare expiresAt: Date | null;
  // Stamped by the daily expiry sweep so a lot is never re-processed.
  @Column(DataType.DATE) declare expiredAt: Date | null;
  // Stamped when a pre-expiry reminder was sent for this lot (once).
  @Column(DataType.DATE) declare reminderSentAt: Date | null;
}

@Table({ tableName: "referrals", timestamps: true })
export class Referral extends Model<Referral> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.UUID) declare referrerId: string;
  @Column(DataType.UUID) declare refereeId: string | null;
  @AllowNull(false) @Unique @Column(DataType.STRING(40)) declare code: string;
  @Default("pending") @Column(DataType.ENUM("pending", "converted", "rewarded")) declare status: string;
  @Column(DataType.DECIMAL(10,2)) declare rewardAmount: number | null;
}

@Table({ tableName: "gift_cards", timestamps: true, paranoid: true })
export class GiftCard extends Model<GiftCard> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Unique @Column(DataType.STRING(40)) declare code: string;
  
  @Default("digital") @Column(DataType.ENUM("physical", "digital", "promotional", "refund")) declare type: string;
  @AllowNull(false) @Column(DataType.DECIMAL(12,2)) declare initialBalance: number;
  @AllowNull(false) @Column(DataType.DECIMAL(12,2)) declare balance: number;
  @Default("INR") @Column(DataType.STRING(10)) declare currency: string;
  
  @Default("active") @Column(DataType.ENUM("active", "paused", "disabled", "expired")) declare status: string;
  @Column(DataType.TEXT) declare description: string | null;
  
  @Column(DataType.UUID) declare customerId: string | null;
  @Column(DataType.UUID) declare purchaserId: string | null;
  @Column(DataType.STRING(255)) declare recipientEmail: string | null;
  @Column(DataType.DATE) declare scheduledDeliveryAt: Date | null;
  
  @Column(DataType.JSONB) declare rules: unknown; // minOrder, maxRedemption, allowedShops, categories, brands, products, customerGroups, countries
  @Default(true) @Column(DataType.BOOLEAN) declare isPartialRedemptionAllowed: boolean;
  @Column(DataType.INTEGER) declare autoExpiryDays: number | null;
  @Column(DataType.DATE) declare expiresAt: Date | null;
  
  @Column(DataType.TEXT) declare notes: string | null;
  @Column(DataType.STRING(255)) declare qrCodeUrl: string | null;
  @Column(DataType.STRING(255)) declare barcodeUrl: string | null;
  @Default(0) @Column(DataType.INTEGER) declare failedAttempts: number;
  
  @Column(DataType.UUID) declare createdBy: string | null;
  @Column(DataType.UUID) declare updatedBy: string | null;

  @HasMany(() => GiftCardTransaction) declare transactions?: GiftCardTransaction[];
}

@Table({ tableName: "gift_card_transactions", timestamps: true })
export class GiftCardTransaction extends Model<GiftCardTransaction> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => GiftCard) @AllowNull(false) @Column(DataType.UUID) declare giftCardId: string;
  @AllowNull(false) @Column(DataType.ENUM("issue", "recharge", "redemption", "refund", "adjustment", "expiry", "status_change")) declare type: string;
  @AllowNull(false) @Column(DataType.DECIMAL(12,2)) declare amount: number;
  @AllowNull(false) @Column(DataType.DECIMAL(12,2)) declare balanceAfter: number;
  
  @Column(DataType.UUID) declare orderId: string | null;
  @Column(DataType.UUID) declare customerId: string | null;
  @Column(DataType.UUID) declare actorId: string | null;
  
  @Column(DataType.STRING(255)) declare idempotencyKey: string | null;
  @Column(DataType.TEXT) declare notes: string | null;
  @Column(DataType.STRING(255)) declare statusTransition: string | null;

  @BelongsTo(() => GiftCard) declare giftCard?: GiftCard;
}

@Table({ tableName: "campaigns", timestamps: true })
export class Campaign extends Model<Campaign> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.STRING(120)) declare name: string;
  @AllowNull(false) @Column(DataType.STRING(40)) declare channel: string;
  @Column(DataType.JSONB) declare segment: unknown;
  @Column(DataType.DATE) declare scheduledAt: Date | null;
  @Default("draft") @Column(DataType.ENUM("draft", "scheduled", "live", "completed", "paused")) declare status: string;
  @Column(DataType.JSONB) declare metrics: unknown;
}
