import { Injectable, Module, Logger } from "@nestjs/common";
import { Cron, CronExpression, ScheduleModule } from "@nestjs/schedule";
import { InjectModel, SequelizeModule, InjectConnection } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { Cart, CartItem, DeliveryAssignment, DeliveryEarning, DeliveryPayout, PriceDropAlert, Product, ProductVariant, OrderShipment, NotificationInbox, NotificationAuditLog } from "@/models";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { NotificationsService } from "@/modules/notifications/notifications.service";

@Injectable()
export class JobsService {
  private readonly log = new Logger("Jobs");

  constructor(
    @InjectConnection() private sequelize: Sequelize,
    @InjectModel(DeliveryAssignment) private assign: typeof DeliveryAssignment,
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(Cart) private cart: typeof Cart,
    @InjectModel(CartItem) private cartItem: typeof CartItem,
    @InjectModel(PriceDropAlert) private alert: typeof PriceDropAlert,
    @InjectModel(ProductVariant) private variant: typeof ProductVariant,
    @InjectModel(Product) private product: typeof Product,
    @InjectModel(DeliveryEarning) private earning: typeof DeliveryEarning,
    @InjectModel(DeliveryPayout) private payout: typeof DeliveryPayout,
    @InjectModel(NotificationInbox) private inbox: typeof NotificationInbox,
    @InjectModel(NotificationAuditLog) private auditLog: typeof NotificationAuditLog,
    private notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireAssignments() {
    const cutoff = new Date(Date.now() - 60_000);
    const [n] = await this.assign.update({ status: "expired" }, { where: { status: "offered", offeredAt: { [Op.lt]: cutoff } } });
    if (n) this.log.log(`Expired ${n} delivery assignments`);
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async abandonedCart() {
    const cutoff = new Date(Date.now() - 2 * 3600_000);
    const carts = await this.cart.findAll({ where: { status: "active", updatedAt: { [Op.lt]: cutoff } as any }, limit: 50 });
    let reminded = 0;
    for (const cart of carts) {
      const count = await this.cartItem.count({ where: { cartId: cart.id } });
      if (!count) continue;
      await this.notifications.notify(
        cart.userId,
        "You left something behind 🛒",
        `You have ${count} item(s) waiting in your cart. Complete your order before they sell out.`,
        "all",
        "/cart",
      );
      // Mark abandoned so we don't spam the same cart every 30 minutes.
      await cart.update({ status: "abandoned" });
      reminded++;
    }
    if (reminded) this.log.log(`Reminded ${reminded} abandoned carts`);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async priceDropSweep() {
    const pending = await this.alert.findAll({ where: { notifiedAt: null }, limit: 200 });
    let fired = 0;
    for (const alert of pending) {
      const variant = await this.variant.findByPk(alert.variantId);
      if (!variant) continue;
      const price = Number(variant.defaultPrice);
      const threshold = alert.threshold != null ? Number(alert.threshold) : Number(variant.mrp);
      if (price <= threshold) {
        const product = variant.productId
          ? await this.product.findByPk(variant.productId, { attributes: ["id", "title"] })
          : null;
        const name = product?.title || "An item on your wishlist";
        await this.notifications.notify(
          alert.userId,
          "Price drop! 📉",
          `${name} is now ₹${price.toFixed(2)} — at or below your target of ₹${threshold.toFixed(2)}.`,
          "all",
          product ? `/product/${product.id}` : "/wishlist",
        );
        await alert.update({ notifiedAt: new Date() });
        fired++;
      }
    }
    if (fired) this.log.log(`Price-drop sweep: notified ${fired} of ${pending.length} pending alerts`);
  }

  @Cron("0 0 * * 1") // Monday 00:00
  async weeklyPayouts() {
    const period = new Date().toISOString().slice(0, 10);
    // Only roll up earnings that have not already been paid out.
    const unsettled = await this.earning.findAll({ where: { settledPayoutId: null } });
    const byPartner = new Map<string, { total: number; ids: string[] }>();
    for (const e of unsettled) {
      const g = byPartner.get(e.partnerId) ?? { total: 0, ids: [] };
      g.total += Number(e.amount);
      g.ids.push(e.id);
      byPartner.set(e.partnerId, g);
    }

    let created = 0;
    for (const [partnerId, g] of byPartner) {
      if (g.total <= 0) continue;
      await this.sequelize.transaction(async (t) => {
        const payout = await this.payout.create({ partnerId, amount: g.total, period, status: "pending" } as any, { transaction: t });
        await this.earning.update({ settledPayoutId: payout.id }, { where: { id: { [Op.in]: g.ids } }, transaction: t });
      });
      created++;
    }
    this.log.log(`Weekly payouts: created ${created} payout(s) from ${unsettled.length} unsettled earning(s)`);
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupNotifications() {
    this.log.log("Starting notification cleanup and archival...");
    
    // 1. Delete expired notifications from inbox
    const expiredCount = await this.inbox.destroy({
      where: {
        expiresAt: { [Op.lt]: new Date() }
      }
    });
    if (expiredCount) this.log.log(`Deleted ${expiredCount} expired notifications from inbox.`);

    // 2. Archive/delete audit logs older than 30 days
    const cutoff = new Date(Date.now() - 30 * 24 * 3600_000);
    const auditCount = await this.auditLog.destroy({
      where: {
        createdAt: { [Op.lt]: cutoff }
      }
    });
    if (auditCount) this.log.log(`Archived/Deleted ${auditCount} notification audit logs older than 30 days.`);
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SequelizeModule.forFeature([DeliveryAssignment, OrderShipment, Cart, CartItem, PriceDropAlert, ProductVariant, Product, DeliveryEarning, DeliveryPayout, NotificationInbox, NotificationAuditLog]),
    NotificationsModule,
  ],
  providers: [JobsService],
})
export class JobsModule {}
