import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { Shop } from "./shop.model";
import { ProductVariant } from "./product-variant.model";

// The unique index leads with shopId, so it cannot serve a lookup by variant
// alone — which is what the cart and the delivery engine do on every request.
// Hence the second, single-column index.
@Table({
  tableName: "shop_inventory",
  timestamps: true,
  indexes: [
    { unique: true, fields: ["shopId", "variantId"] },
    { name: "idx_inventory_variant", fields: ["variantId"] },
  ],
})
export class ShopInventory extends Model<ShopInventory> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @ForeignKey(() => Shop)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare shopId: string;

  @ForeignKey(() => ProductVariant)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare variantId: string;

  @Default(0)
  @Column(DataType.INTEGER)
  declare quantity: number;

  @Column(DataType.DECIMAL(12, 2))
  declare priceOverride: number | null;

  @Default(5)
  @Column(DataType.INTEGER)
  declare lowStockThreshold: number;

  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isActive: boolean;

  @BelongsTo(() => Shop) declare shop?: Shop;
  @BelongsTo(() => ProductVariant) declare variant?: ProductVariant;
}
