import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { ProductVariant } from "./product-variant.model";
import { Shop } from "./shop.model";
import { User } from "./user.model";

@Table({
  tableName: "stock_movements",
  timestamps: true,
  indexes: [
    { fields: ["shopId"] },
    { fields: ["variantId"] },
    { fields: ["createdAt"] },
    { fields: ["type"] }
  ]
})
export class StockMovement extends Model<StockMovement> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => Shop)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare shopId: string;

  @ForeignKey(() => ProductVariant)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare variantId: string;

  @AllowNull(false)
  @Column(DataType.ENUM("PURCHASE", "SALE", "SALE_CANCEL", "RETURN", "TRANSFER_IN", "TRANSFER_OUT", "ADJUSTMENT", "BULK_IMPORT", "PRODUCT_DELETION", "SCAN", "RETURN_RESTOCK_SELLABLE", "RETURN_DAMAGED", "RETURN_QUARANTINE", "RETURN_SCRAPPED", "RESERVATION_HOLD", "RESERVATION_RELEASED", "RESERVATION_CONSUMED"))
  declare type: string;

  @AllowNull(false) @Column(DataType.INTEGER) declare quantity: number;
  @Column(DataType.STRING(120)) declare reason: string | null;
  @Column(DataType.STRING(40)) declare referenceType: string | null;
  @Column(DataType.STRING(120)) declare referenceId: string | null;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  declare createdBy: string | null;

  @BelongsTo(() => ProductVariant) declare variant?: ProductVariant;
  @BelongsTo(() => Shop) declare shop?: Shop;
  @BelongsTo(() => User, { foreignKey: "createdBy", constraints: false }) declare creator?: User;
}
