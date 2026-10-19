import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo, Unique } from "sequelize-typescript";
import { Shop } from "./shop.model";

@Table({ tableName: "settlements", timestamps: true })
export class Settlement extends Model<Settlement> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @Unique
  @AllowNull(false)
  @Column(DataType.STRING(40))
  declare settlementNumber: string;

  @ForeignKey(() => Shop)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare shopId: string;

  @AllowNull(false)
  @Column(DataType.DATE)
  declare startDate: Date;

  @AllowNull(false)
  @Column(DataType.DATE)
  declare endDate: Date;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare grossSales: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare discounts: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare refundDeductions: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare platformCommission: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare gatewayCharges: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare tax: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare adjustments: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare netPayable: number;

  @Default("pending")
  @Column(DataType.ENUM("pending", "processing", "scheduled", "paid", "failed", "archived"))
  declare status: string;

  @Column(DataType.STRING(120))
  declare payoutRef: string | null;

  @Column(DataType.DATE)
  declare paidAt: Date | null;

  @Column(DataType.JSONB)
  declare details: any | null;

  @BelongsTo(() => Shop) declare shop?: Shop;
}
