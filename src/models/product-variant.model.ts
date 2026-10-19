import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, ForeignKey, BelongsTo, HasMany } from "sequelize-typescript";
import { Product } from "./product.model";
import { ProductMedia } from "./product-media.model";
import { ShopInventory } from "./shop-inventory.model";
import { StockMovement } from "./stock-movement.model";

@Table({ tableName: "product_variants", paranoid: true, timestamps: true, indexes: [{ name: "idx_variants_product", fields: ["productId"] }] })
export class ProductVariant extends Model<ProductVariant> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @ForeignKey(() => Product)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare productId: string;

  @AllowNull(false)
  @Unique
  @Column(DataType.STRING(80))
  declare sku: string;

  @Column(DataType.JSONB)
  declare attributes: Record<string, unknown> | null;

  @AllowNull(false)
  @Column(DataType.DECIMAL(12, 2))
  declare defaultPrice: number;

  @AllowNull(false)
  @Column(DataType.DECIMAL(12, 2))
  declare mrp: number;

  // Cost of goods per unit (COGS). Nullable until populated; drives true Net Profit.
  @Column(DataType.DECIMAL(12, 2))
  declare costPrice: number | null;

  @Column(DataType.DECIMAL(8, 3))
  declare weightKg: number | null;

  @Column(DataType.STRING(64))
  declare barcode: string | null;

  @BelongsTo(() => Product) declare product?: Product;
  @HasMany(() => ProductMedia) declare media?: ProductMedia[];
  @HasMany(() => ShopInventory) declare inventory?: ShopInventory[];
  @HasMany(() => StockMovement) declare stockMovements?: StockMovement[];
}
