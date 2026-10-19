import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { ProductVariant } from "./product-variant.model";
import { Shop } from "./shop.model";

@Table({
  tableName: "inventory_reservations",
  timestamps: true,
  indexes: [
    { fields: ["shopId", "variantId"] },
    { fields: ["status", "expiresAt"] },
    { 
      unique: true, 
      fields: ["referenceType", "referenceId"], 
      where: { status: "RESERVED" }, 
      name: "inventory_reservations_unique_active_ref" 
    }
  ]
})
export class InventoryReservation extends Model<InventoryReservation> {
  @PrimaryKey 
  @Default(DataType.UUIDV4) 
  @Column(DataType.UUID) 
  declare id: string;

  @AllowNull(false) 
  @Column(DataType.ENUM("EXCHANGE", "CART", "PREORDER")) 
  declare referenceType: string;

  @AllowNull(false) 
  @Column(DataType.UUID) 
  declare referenceId: string;

  @ForeignKey(() => ProductVariant)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare variantId: string;

  @ForeignKey(() => Shop)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare shopId: string;

  @AllowNull(false) 
  @Column(DataType.INTEGER) 
  declare quantity: number;

  @Default("RESERVED") 
  @Column(DataType.ENUM("RESERVED", "RELEASED", "EXPIRED", "CONSUMED")) 
  declare status: string;

  @AllowNull(false) 
  @Column(DataType.DATE) 
  declare expiresAt: Date;

  @Column(DataType.DATE) 
  declare releasedAt: Date | null;

  @Column(DataType.DATE) 
  declare consumedAt: Date | null;

  @BelongsTo(() => ProductVariant) declare variant?: ProductVariant;
  @BelongsTo(() => Shop) declare shop?: Shop;
}
