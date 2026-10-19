import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { Product } from "./product.model";
import { ProductVariant } from "./product-variant.model";

@Table({ tableName: "product_media", timestamps: true, indexes: [{ name: "idx_media_product", fields: ["productId"] }, { name: "idx_media_variant", fields: ["variantId"] }] })
export class ProductMedia extends Model<ProductMedia> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Product) @Column(DataType.UUID) declare productId: string | null;
  @ForeignKey(() => ProductVariant) @Column(DataType.UUID) declare variantId: string | null;
  @AllowNull(false) @Column(DataType.STRING(500)) declare url: string;
  @AllowNull(false) @Column(DataType.STRING(20)) declare type: string; // image | video | 360
  @Default(0) @Column(DataType.INTEGER) declare sortOrder: number;

  @BelongsTo(() => Product) declare product?: Product;
  @BelongsTo(() => ProductVariant) declare variant?: ProductVariant;
}
