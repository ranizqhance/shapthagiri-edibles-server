import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo, Index } from "sequelize-typescript";
import { Product } from "./product.model";

/**
 * Deal of the Day — a product-level marketing promotion, managed from the
 * Marketing module. Independent of Coupons (cart-level codes) and Campaigns
 * (broadcasts). A product is "on deal" only while `isActive` AND now is within
 * [startsAt, endsAt]. `priority` breaks ties when multiple deals target the same
 * product (highest wins) and orders the storefront "Deals of the Day" rail.
 */
@Table({ tableName: "deals", timestamps: true, paranoid: true })
export class Deal extends Model<Deal> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => Product) @AllowNull(false) @Index @Column(DataType.UUID) declare productId: string;

  // How the deal price is derived from the product's variant price.
  @AllowNull(false) @Column(DataType.ENUM("pct", "flat")) declare discountType: string;
  @AllowNull(false) @Column(DataType.DECIMAL(10, 2)) declare discountValue: number;

  @Column(DataType.DATE) declare startsAt: Date | null;
  @Column(DataType.DATE) declare endsAt: Date | null;

  @Default(0) @Column(DataType.INTEGER) declare priority: number;
  @Default(true) @Index @Column(DataType.BOOLEAN) declare isActive: boolean;

  @Column(DataType.UUID) declare createdBy: string | null;

  @BelongsTo(() => Product) declare product?: Product;
}
