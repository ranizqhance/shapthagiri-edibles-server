import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Index } from "sequelize-typescript";

/**
 * Promotion redemption ledger (Promotion Engine plan, Phase B). One row per
 * (order, applied promotion) — written at order placement and backfilled from historical
 * `promotionSnapshot`s. Powers fast, indexed analytics + usage counting + future
 * promotion usage limits, without scanning the orders JSONB.
 */
@Table({ tableName: "promotion_redemptions", timestamps: true })
export class PromotionRedemption extends Model<PromotionRedemption> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @AllowNull(false) @Index @Column(DataType.UUID) declare promotionId: string;
  @AllowNull(false) @Index @Column(DataType.UUID) declare orderId: string;
  @Index @Column(DataType.UUID) declare userId: string | null;
  @Column(DataType.UUID) declare shopId: string | null;

  @Default(0) @Column(DataType.DECIMAL(12, 2)) declare savedAmount: number;
  @Default(0) @Column(DataType.INTEGER) declare rewardQuantity: number;
  @Column(DataType.STRING(30)) declare promotionType: string | null;
}
