import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { Shop } from "./shop.model";
import { Order } from "./order.model";
import { Settlement } from "./settlement.model";

@Table({ tableName: "ledger_entries", timestamps: true })
export class LedgerEntry extends Model<LedgerEntry> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => Shop)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare shopId: string;

  @ForeignKey(() => Order)
  @Column(DataType.UUID)
  declare orderId: string | null;

  @ForeignKey(() => Settlement)
  @Column(DataType.UUID)
  declare settlementId: string | null;

  @AllowNull(false)
  @Column(DataType.ENUM("order_credit", "refund_debit", "commission_debit", "settlement_debit", "manual_adjustment", "penalty", "bonus", "tax_adjustment"))
  declare type: string;

  @AllowNull(false)
  @Column(DataType.DECIMAL(12, 2))
  declare amount: number;

  @Column(DataType.STRING(300))
  declare description: string | null;

  @Column(DataType.STRING(120))
  declare referenceId: string | null;

  @BelongsTo(() => Shop) declare shop?: Shop;
  @BelongsTo(() => Order) declare order?: Order;
  @BelongsTo(() => Settlement) declare settlement?: Settlement;
}
