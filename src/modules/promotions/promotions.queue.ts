import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker, Job } from "bullmq";
import { env } from "@/config/env";
import { REDIS_OPTIONS as BASE_REDIS_OPTIONS } from "@/common/services/kv";
import { InjectModel } from "@nestjs/sequelize";
import { Coupon, AuditLog } from "@/models";
import { Op } from "sequelize";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { NotificationEventType } from "@/common/enums/notification-event.enum";

const REDIS_OPTIONS = { ...BASE_REDIS_OPTIONS, maxRetriesPerRequest: null };

@Injectable()
export class CouponSchedulerQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("CouponSchedulerQueue");
  private queue?: Queue;
  private worker?: Worker;
  /** REDIS_ENABLED=false: in-process replacement for the every-minute repeat job. */
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectModel(Coupon) private coupon: typeof Coupon,
    @InjectModel(AuditLog) private audit: typeof AuditLog,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    if (!env.REDIS_ENABLED) {
      this.timer = setInterval(() => {
        this.syncCouponStatuses().catch((err) =>
          this.logger.error(`Coupon status sync failed: ${err?.message ?? err}`),
        );
      }, 60_000);
      this.timer.unref?.();
      return;
    }

    this.queue = new Queue("promotions-scheduler", {
      connection: REDIS_OPTIONS,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
    });

    this.worker = new Worker(
      "promotions-scheduler",
      async (job: Job) => {
        if (job.name === "coupon-status-sync") {
          await this.syncCouponStatuses();
        }
      },
      { connection: REDIS_OPTIONS }
    );

    // Schedule the recurring job every minute.
    // Fire-and-forget: Redis is an optional dependency, so a missing/unreachable
    // Redis must NOT block application bootstrap (awaiting queue.add hangs forever
    // when Redis is down because maxRetriesPerRequest is null).
    this.queue
      .add("coupon-status-sync", {}, {
        repeat: {
          pattern: "* * * * *", // Every minute
        },
        jobId: "coupon-status-sync-cron",
      })
      .catch((err) =>
        this.logger.warn(
          `Could not schedule coupon-status-sync (Redis unavailable?): ${err?.message ?? err}`,
        ),
      );

    this.worker.on("failed", (job, err) => {
      this.logger.error(`Promotions Scheduler job failed: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.worker) await this.worker.close();
    if (this.queue) await this.queue.close();
  }

  private async syncCouponStatuses() {
    const now = new Date();

    // 1. Activate scheduled coupons that have reached their startsAt
    const toActivate = await this.coupon.findAll({
      where: {
        status: "draft",
        startsAt: { [Op.lte]: now },
      }
    });

    for (const c of toActivate) {
      await c.update({ status: "active", isActive: true });
      await this.audit.create({
        actorId: "system", action: "ACTIVATE", entity: "Coupon", entityId: c.id,
      } as any);
      
      this.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.COUPON_UPDATED, // Using UPDATED as there's no specific ACTIVATED
        variables: { couponId: c.id, code: c.code, activated: true }
      });
      
      this.logger.log(`Activated coupon ${c.code}`);
    }

    // 2. Expire active coupons that have passed their expiresAt
    const toExpire = await this.coupon.findAll({
      where: {
        status: "active",
        expiresAt: { [Op.lt]: now },
      }
    });

    for (const c of toExpire) {
      await c.update({ status: "expired", isActive: false });
      await this.audit.create({
        actorId: "system", action: "EXPIRE", entity: "Coupon", entityId: c.id,
      } as any);
      
      this.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.COUPON_EXPIRED,
        variables: { couponId: c.id, code: c.code }
      });
      
      this.logger.log(`Expired coupon ${c.code}`);
    }
  }
}
