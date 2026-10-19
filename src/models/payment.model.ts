import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo, HasMany } from "sequelize-typescript";
import { Order } from "./order.model";

@Table({ tableName: "payments", timestamps: true, indexes: [{ name: "idx_payments_order", fields: ["orderId"] }] })
export class Payment extends Model<Payment> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Order) @AllowNull(false) @Column(DataType.UUID) declare orderId: string;
  @AllowNull(false) @Column(DataType.STRING(20)) declare method: string;
  @AllowNull(false) @Column(DataType.STRING(40)) declare gateway: string;
  @Column(DataType.STRING(120)) declare gatewayRef: string | null;
  @Column(DataType.STRING(120)) declare gatewayReferenceId: string | null; // Razorpay order/reference ID
  @AllowNull(false) @Column(DataType.DECIMAL(12,2)) declare amount: number;
  @Default("pending") @Column(DataType.ENUM("pending", "authorized", "captured", "failed", "refunded")) declare status: string;
  @Column(DataType.JSONB) declare attempts: unknown;
  @Column(DataType.STRING(120)) declare idempotencyKey: string | null;

  @BelongsTo(() => Order) declare order?: Order;
  @HasMany(() => PaymentRefund) declare refunds?: PaymentRefund[];
}

@Table({ tableName: "payment_refunds", timestamps: true, indexes: [{ name: "idx_payment_refunds_payment", fields: ["paymentId"] }] })
export class PaymentRefund extends Model<PaymentRefund> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Payment) @AllowNull(false) @Column(DataType.UUID) declare paymentId: string;
  @AllowNull(false) @Column(DataType.DECIMAL(12,2)) declare amount: number;
  @Column(DataType.STRING(200)) declare reason: string | null;
  @Default("pending") @Column(DataType.ENUM("pending", "processing", "succeeded", "failed")) declare status: string;
  @Column(DataType.STRING(120)) declare refundRef: string | null;

  @BelongsTo(() => Payment) declare payment?: Payment;
}

@Table({ tableName: "invoices", timestamps: true })
export class Invoice extends Model<Invoice> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Order) @AllowNull(false) @Column(DataType.UUID) declare orderId: string;
  @AllowNull(false) @Column(DataType.STRING(40)) declare number: string;
  @Column(DataType.STRING(500)) declare url: string | null;
  @Column(DataType.DATE) declare issuedAt: Date | null;

  @BelongsTo(() => Order) declare order?: Order;
}

@Table({ tableName: "tax_records", timestamps: true })
export class TaxRecord extends Model<TaxRecord> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.STRING(20)) declare period: string;
  @Column(DataType.STRING(60)) declare state: string | null;
  @Default(0) @Column(DataType.DECIMAL(14,2)) declare collected: number;
  @Default(0) @Column(DataType.DECIMAL(14,2)) declare remitted: number;
  @Default("pending") @Column(DataType.ENUM("pending", "remitted")) declare status: string;
}
