import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo, HasMany } from "sequelize-typescript";
import { User } from "./user.model";
import { ProductVariant } from "./product-variant.model";
import { GiftCard } from "./promotion.model";

@Table({ tableName: "carts", timestamps: true, indexes: [{ name: "idx_carts_user_status", fields: ["userId", "status"] }] })
export class Cart extends Model<Cart> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => User) @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  @Default("active") @Column(DataType.ENUM("active", "converted", "abandoned")) declare status: string;
  @Column(DataType.STRING(40)) declare couponCode: string | null;
  @ForeignKey(() => GiftCard) @Column(DataType.UUID) declare giftCardId: string | null;
  @Default("combined") @Column(DataType.ENUM("combined", "split")) declare deliveryMode: string;

  @BelongsTo(() => User) declare user?: User;
  @BelongsTo(() => GiftCard) declare giftCard?: GiftCard;
  @HasMany(() => CartItem) declare items?: CartItem[];
}

@Table({ tableName: "cart_items", timestamps: true, indexes: [{ name: "idx_cart_items_cart", fields: ["cartId"] }, { name: "idx_cart_items_variant", fields: ["variantId"] }] })
export class CartItem extends Model<CartItem> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Cart) @AllowNull(false) @Column(DataType.UUID) declare cartId: string;
  @ForeignKey(() => ProductVariant) @AllowNull(false) @Column(DataType.UUID) declare variantId: string;
  @AllowNull(false) @Column(DataType.INTEGER) declare quantity: number;
  @AllowNull(false) @Column(DataType.DECIMAL(12,2)) declare priceSnapshot: number;
  // Serving shop this line was added from (single-serving-shop). Null = legacy/global.
  @Column(DataType.UUID) declare shopId: string | null;

  @BelongsTo(() => Cart) declare cart?: Cart;
  @BelongsTo(() => ProductVariant) declare variant?: ProductVariant;
}
