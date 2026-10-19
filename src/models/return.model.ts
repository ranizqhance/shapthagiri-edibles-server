import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo, HasMany, HasOne } from "sequelize-typescript";
import { User } from "./user.model";
import { OrderItem } from "./order-shipment.model";
import { ProductVariant } from "./product-variant.model";
import { Order } from "./order.model";

@Table({ tableName: "returns", timestamps: true, indexes: [{ name: "idx_returns_order_item", fields: ["orderItemId"] }, { name: "idx_returns_user_status", fields: ["userId", "status"] }] })
export class Return extends Model<Return> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => OrderItem) @AllowNull(false) @Column(DataType.UUID) declare orderItemId: string;
  @ForeignKey(() => User) @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  // Units being returned. Nullable for backward compatibility: null = the whole
  // line (= OrderItem.quantity). New requests always set an explicit quantity.
  @Column(DataType.INTEGER) declare quantity: number | null;
  @AllowNull(false) @Column(DataType.STRING(100)) declare reason: string;
  @Default("requested") @Column(DataType.ENUM("requested", "approved", "pickup_scheduled", "picked", "inspected", "refunded", "rejected", "picked_up", "received_at_shop", "inspection_passed", "inspection_failed", "refund_processing", "closed")) declare status: string;
  @Column(DataType.DATE) declare pickupScheduledAt: Date | null;
  @Column(DataType.UUID) declare refundId: string | null;
  @Column(DataType.STRING(1000)) declare inspectionComments: string | null;
  @Column(DataType.DECIMAL(10, 2)) declare refundAmount: number | null;
  @Column(DataType.STRING(100)) declare refundTransactionId: string | null;
  @Default("pickup") @Column(DataType.ENUM("pickup", "self_drop")) declare method: string;
  @Column(DataType.ENUM("WALLET", "SOURCE", "BANK_TRANSFER")) declare refundDestination: string | null;

  @BelongsTo(() => User) declare user?: User;
  @BelongsTo(() => OrderItem) declare orderItem?: OrderItem;
  @HasMany(() => ReturnMedia) declare media?: ReturnMedia[];
  @HasOne(() => Exchange) declare exchange?: any;
}

@Table({ tableName: "return_media", timestamps: true })
export class ReturnMedia extends Model<ReturnMedia> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Return) @AllowNull(false) @Column(DataType.UUID) declare returnId: string;
  @AllowNull(false) @Column(DataType.STRING(500)) declare url: string;

  @BelongsTo(() => Return) declare return?: Return;
}

@Table({ tableName: "exchanges", timestamps: true })
export class Exchange extends Model<Exchange> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Return) @AllowNull(false) @Column(DataType.UUID) declare returnId: string;
  @ForeignKey(() => ProductVariant) @AllowNull(false) @Column(DataType.UUID) declare replacementVariantId: string;
  // Units being replaced. Nullable = whole line (legacy); cascades into the
  // stock reservation and the replacement order item.
  @Column(DataType.INTEGER) declare quantity: number | null;

  @ForeignKey(() => Order)
  @Column(DataType.UUID) declare newOrderId: string | null;

  @BelongsTo(() => Order, "newOrderId")
  declare newOrder: Order | null;

  @Default("pending")
  @Column(DataType.ENUM(
    "pending", "shipped", "delivered",
    "REQUESTED", "APPROVED", "WAITING_FOR_PICKUP", "PICKED_UP", "QC_PASSED", "QC_FAILED",
    "WAITING_FOR_REPLACEMENT_STOCK", "REPLACEMENT_ALLOCATED", "PACKED",
    "REPLACEMENT_ORDER_CREATED", "REPLACEMENT_SHIPPED", "REPLACEMENT_DELIVERED", "COMPLETED"
  ))
  declare status: string;

  @BelongsTo(() => Return) declare return?: Return;
}
