import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { Product } from "./product.model";

@Table({ tableName: "product_policies", timestamps: true, paranoid: true })
export class ProductPolicy extends Model<ProductPolicy> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @ForeignKey(() => Product)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare productId: string;

  @AllowNull(false)
  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isReturnable: boolean;

  @AllowNull(false)
  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isReplaceable: boolean;

  @AllowNull(false)
  @Default(7)
  @Column(DataType.INTEGER)
  declare returnWindowDays: number;

  @AllowNull(false)
  @Default(7)
  @Column(DataType.INTEGER)
  declare replacementWindowDays: number;

  @AllowNull(false)
  @Default("NONE")
  @Column(DataType.ENUM("NONE", "FIXED", "PERCENTAGE"))
  declare restockingFeeType: string;

  @AllowNull(false)
  @Default(0)
  @Column(DataType.DECIMAL(10, 2))
  declare restockingFeeValue: number;

  @AllowNull(false)
  @Default(false)
  @Column(DataType.BOOLEAN)
  declare requiresInspection: boolean;

  @BelongsTo(() => Product) declare product?: Product;
}
