import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, ForeignKey, BelongsTo, HasMany, HasOne } from "sequelize-typescript";
import { OrderStatus, PaymentMethod, PaymentStatus, OrderType } from "../common/enums/order-status.enum";
import { User } from "./user.model";
import { OrderShipment } from "./order-shipment.model";
import { GiftCard } from "./promotion.model";
import { Payment } from "./payment.model";

@Table({ tableName: "orders", paranoid: true, timestamps: true, indexes: [{ name: "idx_orders_user_created", fields: ["userId", "createdAt"] }, { name: "idx_orders_status", fields: ["status"] }, { name: "idx_orders_created", fields: ["createdAt"] }] })
export class Order extends Model<Order> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Default(OrderType.NORMAL)
  @Column(DataType.ENUM(...Object.values(OrderType)))
  declare orderType: OrderType;

  @ForeignKey(() => Order)
  @Column(DataType.UUID)
  declare originalOrderId: string | null;

  // Unique + indexed: this is the handle a customer quotes to track an order
  // without signing in, so the public lookup must resolve it to exactly one
  // row and must not table-scan.
  @AllowNull(false)
  @Unique
  @Column(DataType.STRING(32))
  declare orderNumber: string;

  @ForeignKey(() => User)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare userId: string;

  @Default(OrderStatus.PLACED)
  @Column(DataType.ENUM(...Object.values(OrderStatus)))
  declare status: OrderStatus;

  @AllowNull(false) @Column(DataType.DECIMAL(12, 2)) declare subtotal: number;
  @Default(0)       @Column(DataType.DECIMAL(12, 2)) declare discount: number;
  @Default(0)       @Column(DataType.DECIMAL(12, 2)) declare deliveryFee: number;

  /**
   * What the parcel weighed, in grams — products plus per-piece wrapping plus
   * the outer box. Kept because `deliveryFee` alone cannot be explained once
   * the rate card or the packaging allowances change.
   */
  @Column(DataType.INTEGER) declare parcelWeightG: number | null;
  @Default(0)       @Column(DataType.DECIMAL(12, 2)) declare tax: number;
  @AllowNull(false) @Column(DataType.DECIMAL(12, 2)) declare total: number;

  // The cart this order was placed from. The cart is only emptied once the
  // order is actually paid, so the link has to outlive placement. Null means
  // the order did not come from the cart (Buy Now) and the cart — which may
  // hold unrelated items — must never be touched for it.
  @Column(DataType.UUID)
  declare cartId: string | null;

  @Column(DataType.STRING(40))
  declare couponCode: string | null;

  @ForeignKey(() => GiftCard)
  @Column(DataType.UUID)
  declare giftCardId: string | null;

  @Default(0) @Column(DataType.DECIMAL(12, 2))
  declare giftCardDiscount: number;

  // Loyalty points discount applied to this order (itemises what `total` already reflects).
  @Default(0) @Column(DataType.DECIMAL(12, 2))
  declare loyaltyDiscount: number;

  // Amount paid from the customer's wallet balance (full or partial).
  @Default(0) @Column(DataType.DECIMAL(12, 2))
  declare walletAmount: number;

  /**
   * What the customer still owes the gateway/COD after gift card + wallet:
   * total − giftCardDiscount − walletAmount. This is the ONLY amount a payment
   * intent may charge — `total` is the gross and would double-charge.
   */
  @Default(0) @Column(DataType.DECIMAL(12, 2))
  declare payableAmount: number;

  @AllowNull(false)
  @Column(DataType.ENUM(...Object.values(PaymentMethod)))
  declare paymentMethod: PaymentMethod;

  @Default(PaymentStatus.PENDING)
  @Column(DataType.ENUM(...Object.values(PaymentStatus)))
  declare paymentStatus: PaymentStatus;

  @Column(DataType.JSONB)
  declare addressSnapshot: Record<string, unknown> | null;

  @Column(DataType.STRING(20))
  declare deliveryOption: string | null;

  @Column(DataType.DATE)
  declare placedAt: Date | null;

  /**
   * Snapshot of the applied BOGO promotion at placement time:
   * `{ couponCode, rule: {shopId,buyVariantId,getVariantId,buyQty,getQty,discountPercent}, rewards: [...], savings }`.
   * Frozen here so order history/analytics survive later edits or deletion of the coupon.
   */
  @Column(DataType.JSONB)
  declare bogoSnapshot: Record<string, unknown> | null;

  /**
   * Promotion Engine (Phase 3) snapshot of the full orchestrated pricing: applied
   * automatic promotions + coupon + stacking decision + reward lines. Written only when
   * the engine flag was ON at placement; null otherwise (legacy path uses `bogoSnapshot`).
   */
  @Column(DataType.JSONB)
  declare promotionSnapshot: Record<string, unknown> | null;

  @BelongsTo(() => User) declare user?: User;
  @BelongsTo(() => GiftCard) declare giftCard?: GiftCard;
  @HasOne(() => Payment) declare payment?: Payment;
  @HasMany(() => OrderShipment) declare shipments?: OrderShipment[];
}
