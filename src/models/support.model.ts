import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo, HasMany } from "sequelize-typescript";
import { User } from "./user.model";
import { Order } from "./order.model";

@Table({ tableName: "support_tickets", timestamps: true })
export class SupportTicket extends Model<SupportTicket> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => User) @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  @ForeignKey(() => Order) @Column(DataType.UUID) declare orderId: string | null;
  @AllowNull(false) @Column(DataType.STRING(200)) declare subject: string;
  @Default("medium") @Column(DataType.ENUM("low", "medium", "high", "urgent")) declare priority: string;
  @Default("open") @Column(DataType.ENUM("open", "in_progress", "resolved", "closed")) declare status: string;
  @Column(DataType.UUID) declare assignedTo: string | null;

  @BelongsTo(() => User) declare user?: User;
  @BelongsTo(() => Order) declare order?: Order;
}

@Table({ tableName: "ticket_messages", timestamps: true })
export class TicketMessage extends Model<TicketMessage> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.UUID) declare ticketId: string;
  @AllowNull(false) @Column(DataType.UUID) declare senderId: string;
  @AllowNull(false) @Column(DataType.TEXT) declare body: string;
  @Column(DataType.JSONB) declare attachments: unknown;
}

@Table({ tableName: "disputes", timestamps: true })
export class Dispute extends Model<Dispute> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Order) @AllowNull(false) @Column(DataType.UUID) declare orderId: string;
  @ForeignKey(() => User) @AllowNull(false) @Column(DataType.UUID) declare customerId: string;
  // Category of grievance (item_not_received | not_as_described | damaged |
  // wrong_item | billing | delivery | other).
  @Default("other") @Column(DataType.STRING(40)) declare type: string | null;
  // Provenance: customer | staff | chargeback (gateway-initiated).
  @Default("customer") @Column(DataType.STRING(20)) declare source: string | null;
  // Payment-gateway dispute id — makes chargeback ingestion idempotent.
  @Column(DataType.STRING(120)) declare externalRef: string | null;
  @AllowNull(false) @Column(DataType.STRING(300)) declare issue: string;
  @Default("medium") @Column(DataType.STRING(20)) declare priority: string;
  // open | under_review | awaiting_customer | escalated | resolved | rejected.
  @Default("open") @Column(DataType.STRING(30)) declare status: string;
  @Column(DataType.TEXT) declare resolution: string | null;

  // Workflow / governance.
  @ForeignKey(() => User) @Column(DataType.UUID) declare assignedTo: string | null;
  @Column(DataType.DATE) declare slaDueAt: Date | null;

  // What the customer is asking for + optional monetary claim.
  @Column(DataType.STRING(40)) declare desiredResolution: string | null;
  @Column(DataType.DECIMAL(12, 2)) declare amountClaimed: number | null;

  // Resolution outcome (refund_wallet | refund_source | gift_card | replacement |
  // goodwill | none) + how much money moved.
  @Column(DataType.STRING(40)) declare resolutionType: string | null;
  @Column(DataType.DECIMAL(12, 2)) declare resolutionAmount: number | null;
  @Column(DataType.UUID) declare resolvedBy: string | null;
  @Column(DataType.DATE) declare resolvedAt: Date | null;
  @Column(DataType.STRING(500)) declare closedReason: string | null;

  @BelongsTo(() => User, "customerId") declare customer?: User;
  @BelongsTo(() => User, "assignedTo") declare agent?: User;
  @BelongsTo(() => Order) declare order?: Order;
  @HasMany(() => DisputeMessage) declare messages?: DisputeMessage[];
}

@Table({ tableName: "dispute_messages", timestamps: true })
export class DisputeMessage extends Model<DisputeMessage> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Dispute) @AllowNull(false) @Column(DataType.UUID) declare disputeId: string;
  @AllowNull(false) @Column(DataType.UUID) declare senderId: string;
  @Column(DataType.STRING(20)) declare senderRole: string | null;
  @AllowNull(false) @Column(DataType.TEXT) declare body: string;
  @Column(DataType.JSONB) declare attachments: unknown;
  // Internal staff-only note (hidden from the customer thread).
  @Default(false) @Column(DataType.BOOLEAN) declare internal: boolean;

  @BelongsTo(() => Dispute) declare dispute?: Dispute;
  @BelongsTo(() => User, "senderId") declare sender?: User;
}
