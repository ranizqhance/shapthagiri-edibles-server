import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { ProductVariant } from "./product-variant.model";

@Table({ tableName: "wishlists", timestamps: true })
export class Wishlist extends Model<Wishlist> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.UUID) declare userId: string;
}

@Table({ tableName: "wishlist_items", timestamps: true, indexes: [{ name: "idx_wishlist_variant", fields: ["variantId"] }] })
export class WishlistItem extends Model<WishlistItem> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.UUID) declare wishlistId: string;
  @ForeignKey(() => ProductVariant) @AllowNull(false) @Column(DataType.UUID) declare variantId: string;

  @BelongsTo(() => ProductVariant) declare variant?: ProductVariant;
}

@Table({ tableName: "price_drop_alerts", timestamps: true })
export class PriceDropAlert extends Model<PriceDropAlert> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  @AllowNull(false) @Column(DataType.UUID) declare variantId: string;
  @Column(DataType.DECIMAL(12,2)) declare threshold: number | null;
  @Column(DataType.DATE) declare notifiedAt: Date | null;
}

@Table({ tableName: "back_in_stock_alerts", timestamps: true })
export class BackInStockAlert extends Model<BackInStockAlert> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  @AllowNull(false) @Column(DataType.UUID) declare variantId: string;
  @Column(DataType.DATE) declare notifiedAt: Date | null;
}
