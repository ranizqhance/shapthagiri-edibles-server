import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { Shop } from "./shop.model";

@Table({ tableName: "earning_wallets", timestamps: true })
export class EarningWallet extends Model<EarningWallet> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => Shop)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare shopId: string;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare pendingEarnings: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare availableEarnings: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare lockedBalance: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare paidBalance: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare upcomingSettlementAmount: number;

  @Default(0)
  @Column(DataType.DECIMAL(12, 2))
  declare lastSettlementAmount: number;

  @Column(DataType.DATE)
  declare lastSettlementAt: Date | null;

  @BelongsTo(() => Shop) declare shop?: Shop;

  /**
   * Idempotently credit a shop's pending earnings when a shipment is delivered,
   * and record the matching `order_credit` ledger entry. Keyed on the shipment
   * number so the two delivery paths (ops "mark delivered" + partner "deliver")
   * — or any retry — only ever move money once. The ledger row is later linked
   * to a settlement by the settlement sweep.
   */
  static async creditOnDelivery(params: { shopId: string; orderId: string; amount: number; referenceId: string }) {
    const { shopId, orderId, amount, referenceId } = params;
    const self = this as any;
    const Ledger = self.sequelize.models.LedgerEntry;

    const existing = await Ledger.findOne({ where: { type: "order_credit", referenceId } });
    if (existing) return; // already credited for this shipment

    const [wallet] = await self.findOrCreate({
      where: { shopId },
      defaults: { shopId, pendingEarnings: 0, availableEarnings: 0, lockedBalance: 0, paidBalance: 0, upcomingSettlementAmount: 0 },
    });
    await wallet.update({ pendingEarnings: Number(wallet.pendingEarnings) + Number(amount) });

    await Ledger.create({
      shopId,
      orderId,
      settlementId: null,
      type: "order_credit",
      amount,
      description: "Order earnings credited on delivery",
      referenceId,
    });
  }
}
