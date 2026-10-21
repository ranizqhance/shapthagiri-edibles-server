import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/sequelize';
import { EarningWallet, LedgerEntry, AuditLog, User, Setting } from '@/models';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { Role } from '@/common/enums/role.enum';

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  constructor(
    @InjectModel(EarningWallet) private walletModel: typeof EarningWallet,
    @InjectModel(LedgerEntry) private ledgerModel: typeof LedgerEntry,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(Setting) private settingModel: typeof Setting,
    private notifications: NotificationsService,
  ) {}

  @OnEvent('RefundCompleted')
  async handleRefundCompleted(payload: { returnId: string, amount: number, transactionId: string, orderId: string, shopId: string }) {
    const { returnId, amount, transactionId, orderId, shopId } = payload;
    
    // Idempotency check: ensuring exactly-once financial processing
    const existingLedger = await this.ledgerModel.findOne({
      where: { referenceId: transactionId || `refund_${returnId}`, type: 'refund_debit' }
    });
    
    if (existingLedger) {
      this.logger.warn(`Refund already processed in finance for return ${returnId}`);
      return;
    }

    const [wallet] = await this.walletModel.findOrCreate({
      where: { shopId },
      defaults: { shopId, pendingEarnings: 0, availableEarnings: 0, lockedBalance: 0, paidBalance: 0, upcomingSettlementAmount: 0 } as any,
    });

    let currentAvailable = Number(wallet.availableEarnings);
    let currentPending = Number(wallet.pendingEarnings);

    // Reverse the platform's cut so the merchant is debited only the NET they actually
    // earned on the refunded amount (not the gross): commission + gateway + tax are all
    // returned. Rates come from the same Settings keys the settlement engine uses.
    const [commissionRateSetting, gatewayRateSetting, taxRateSetting] = await Promise.all([
      this.settingModel.findOne({ where: { key: "platform.commission.rate" } }),
      this.settingModel.findOne({ where: { key: "gateway.fee.rate" } }),
      this.settingModel.findOne({ where: { key: "tax.rate" } }),
    ]);
    const commissionRate = commissionRateSetting ? Number(commissionRateSetting.value) : 0.05;
    const gatewayRate = gatewayRateSetting ? Number(gatewayRateSetting.value) : 0.02;
    const taxRate = taxRateSetting ? Number(taxRateSetting.value) : 0.18;

    const commissionReversal = amount * commissionRate;
    const gatewayReversal = amount * gatewayRate;
    const taxReversal = amount * taxRate;

    const actualDeduction = amount - commissionReversal - gatewayReversal - taxReversal;
    let deduct = actualDeduction;

    // Take from available, then pending. Anything left over (a refund after the money was
    // paid out) leaves available negative: the shop owes it back and the next settlement nets it.
    // Clamping at zero here made the wallet drift above the ledger.
    if (currentAvailable >= deduct) {
      currentAvailable -= deduct;
    } else {
      deduct -= Math.max(currentAvailable, 0);
      currentAvailable = Math.min(currentAvailable, 0);
      const fromPending = Math.min(Math.max(currentPending, 0), deduct);
      currentPending -= fromPending;
      currentAvailable -= deduct - fromPending;
    }

    await wallet.update({ availableEarnings: currentAvailable, pendingEarnings: currentPending });

    // Ledger Entry for Refund
    await this.ledgerModel.create({
      shopId,
      orderId,
      type: "refund_debit",
      amount: -amount,
      description: `Return refund processed`,
      referenceId: transactionId || `refund_${returnId}`
    } as any);

    // Ledger entries for the reversed platform cut (net ledger impact = −actualDeduction).
    if (commissionReversal > 0) {
      await this.ledgerModel.create({
        shopId,
        orderId,
        type: "manual_adjustment",
        amount: commissionReversal,
        description: `Platform commission reversed for return`,
        referenceId: `comm_rev_${transactionId || returnId}`
      } as any);
    }
    if (gatewayReversal > 0) {
      await this.ledgerModel.create({
        shopId,
        orderId,
        type: "manual_adjustment",
        amount: gatewayReversal,
        description: `Gateway charges reversed for return`,
        referenceId: `gw_rev_${transactionId || returnId}`
      } as any);
    }
    if (taxReversal > 0) {
      await this.ledgerModel.create({
        shopId,
        orderId,
        type: "tax_adjustment",
        amount: taxReversal,
        description: `Tax reversed for return`,
        referenceId: `tax_rev_${transactionId || returnId}`
      } as any);
    }

    await this.auditLogModel.create({
      actorId: null,
      action: "refund_impact",
      entity: "EarningWallet",
      entityId: wallet.id,
      before: { availableEarnings: wallet.availableEarnings, pendingEarnings: wallet.pendingEarnings },
      after: { availableEarnings: currentAvailable, pendingEarnings: currentPending },
    } as any);

    const manager = await this.userModel.findOne({ where: { shopId, role: Role.SHOP_MANAGER } });
    if (manager) {
      await this.notifications.notify(
        manager.id,
        "Refund Deducted 📉",
        `An amount of ₹${actualDeduction.toFixed(2)} (after commission reversal) has been deducted from your earnings for a return refund.`
      );
    }
  }
}
