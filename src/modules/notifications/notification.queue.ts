import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from "@nestjs/common";
import { Queue, Worker, Job } from "bullmq";
import { env } from "@/config/env";
import { createKvClient, KvClient, REDIS_OPTIONS as BASE_REDIS_OPTIONS } from "@/common/services/kv";
import { NotificationsService, NotifyChannel } from "./notifications.service";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { OrdersService } from "../orders/orders.service";
import { PaymentsService } from "../payments/payments.service";
import { InjectModel } from "@nestjs/sequelize";
import { User } from "@/models";
import { Role } from "@/common/enums/role.enum";
import { TrackingGateway } from "../tracking/tracking.gateway";
import { isDeliverableEmail } from "@/common/utils/email.util";

/**
 * The worker holds a blocking connection (BRPOPLPUSH), which BullMQ requires to
 * have `maxRetriesPerRequest: null` — a bounded value makes it throw. That is
 * safe here because the worker runs in the background; nothing waits on it.
 */
const WORKER_REDIS_OPTIONS = { ...BASE_REDIS_OPTIONS, maxRetriesPerRequest: null, enableOfflineQueue: true };

/**
 * The producer keeps the fail-fast defaults from `kv.ts`.
 *
 * This connection is the one HTTP requests wait on. It previously shared the
 * worker's `maxRetriesPerRequest: null` while ioredis still queued commands
 * offline, so with Redis unreachable `queue.add()` neither resolved nor
 * rejected — and callers that awaited it (order placement, returns, inventory
 * edits, every fulfilment transition) hung for good.
 */
const PRODUCER_REDIS_OPTIONS = { ...BASE_REDIS_OPTIONS };

/** Nothing on a request path may wait on the queue longer than this. */
const ENQUEUE_TIMEOUT_MS = 2000;

/**
 * Bound any queue call, whatever the driver decides to do.
 *
 * The connection options above should make a dead Redis reject in
 * milliseconds; this is the backstop that guarantees it, so a future options
 * change cannot quietly reintroduce an unbounded wait on the request path.
 */
async function withEnqueueTimeout<T>(what: string, op: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ENQUEUE_TIMEOUT_MS}ms`)), ENQUEUE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Mirrors the BullMQ defaultJobOptions below, for the in-process runner. */
const LOCAL_ATTEMPTS = 5;
const LOCAL_BACKOFF_MS = 10000;


@Injectable()
export class NotificationQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("NotificationQueue");
  private redisConnection!: KvClient;
  /** Undefined when REDIS_ENABLED=false — jobs then run in-process via runLocal(). */
  public queue?: Queue;
  private worker?: Worker;
  private localSeq = 0;

  constructor(
    @Inject(forwardRef(() => NotificationsService))
    private notificationsService: NotificationsService,
    @Inject(forwardRef(() => OrdersService))
    private ordersService: OrdersService,
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
    @InjectModel(User) private userModel: typeof User,
    @Inject(forwardRef(() => TrackingGateway))
    private trackingGateway: TrackingGateway,
  ) {}

  onModuleInit() {
    this.redisConnection = createKvClient((err) => this.logger.warn(`Redis error: ${err.message}`));

    if (!env.REDIS_ENABLED) {
      this.logger.warn("REDIS_ENABLED=false — notification jobs run in-process (not persisted; digest jobs disabled)");
      return;
    }

    this.queue = new Queue("notifications", {
      connection: PRODUCER_REDIS_OPTIONS,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 10000, // Starts at 10s, then 20s, 40s...
        },
        removeOnComplete: { age: 3600 * 24 }, // Cleanup completed after 24h
        removeOnFail: false, // Keep failed for DLQ/investigation
      },
    });

    this.worker = new Worker(
      "notifications",
      (job: Job) => this.processJob(job),
      {
        connection: WORKER_REDIS_OPTIONS,
        concurrency: 5,
      }
    );

    // Setup DLQ Failure Handler
    this.worker.on("failed", (job, err) => this.onJobFailed(job, err));

    this.worker.on("error", (err) => {
      this.logger.error("Queue Worker encountered an error", err);
    });

    // Setup digest cron jobs
    this.setupDigestJobs();
  }

  /** Worker body — shared by the BullMQ worker and the in-process runner. */
  private async processJob(job: Job) {
    if (job.name === "dispatch") {
      return this.handleDispatchJob(job);
    }
    if (job.name === "escalate") {
      return this.handleEscalationJob(job);
    }
    if (job.name.startsWith("digest:")) {
      const type = job.name.split(":")[1];
      return this.notificationsService.processDigests(type as "hourly" | "daily" | "weekly");
    }

    const { userId, eventType, variables, channel } = job.data;
    this.logger.log(`Processing job ${job.id} for user ${userId} / event ${eventType}`);

    // Handle payment hold timeout:
    // First verify with Razorpay — if the payment was actually captured
    // (user paid but browser dropped the /verify call), capture it now
    // and leave the order alone. Only cancel if truly unpaid.
    if (eventType === NotificationEventType.PAYMENT_FAILED) {
      if (variables.orderId) {
        const wasCaptured = await this.paymentsService.jitReconcileOrder(variables.orderId);
        if (!wasCaptured) {
          await this.ordersService.releasePaymentTimeoutOrder(variables.orderId);
        } else {
          this.logger.log(`Payment captured via JIT during timeout check for order ${variables.orderId} — cancellation skipped.`);
        }
      }
      return { success: true };
    }

    // 1. Advanced Idempotency & Deduplication
    const idempotencyKey = variables.idempotencyKey || `${userId}:${eventType}:${variables.orderNumber || variables.productId || Date.now()}`;
    const deduplicationResult = await this.handleIdempotencyAndDeduplication(idempotencyKey, userId, eventType, variables);
    if (deduplicationResult.skipped) {
      this.logger.warn(`Duplicate job detected for key: ${idempotencyKey}. Incremented occurrences.`);
      return { skipped: true, reason: deduplicationResult.reason };
    }

    // 2. Render Template
    const { title, body } = await this.notificationsService.renderTemplate(eventType, variables);

    // 3. Rate Limiting Check
    if (env.ENABLE_RATE_LIMIT) {
      const limitReached = await this.checkRateLimit(userId);
      if (limitReached) {
        this.logger.warn(`Rate limit hit for user ${userId}. Re-queueing with delay.`);
        throw new Error(`Rate limit exceeded for user ${userId}`); // Retries will backoff
      }
    }

    // 4. Dispatch Alert
    let targetChannel: NotifyChannel = channel || "all";
    
    let priority: string = "MEDIUM";
    let category: string = "system";
    let actions: any[] = [];
    let clickAction: string | undefined = undefined;
    let thumbnail: string | undefined = undefined;

    if (
      [
        NotificationEventType.NEW_ORDER, 
        NotificationEventType.ORDER_CANCELLED, 
        NotificationEventType.ORDER_REFUNDED,
        NotificationEventType.PAYMENT_CAPTURED,
        NotificationEventType.SHIPMENT_ASSIGNED,
        NotificationEventType.HIGH_VALUE_ORDER,
        NotificationEventType.LARGE_QTY_ORDER
      ].includes(eventType)
    ) {
       category = "orders";
       if (eventType === NotificationEventType.NEW_ORDER) {
         priority = "HIGH";
         if (variables.orderId) {
           clickAction = `/orders/${variables.orderId}`;
           actions.push({ label: "View Order", url: `/orders/${variables.orderId}`, method: "GET" });
           actions.push({ label: "Assign Delivery", url: `/orders/${variables.orderId}/delivery`, method: "GET" });
         }
       } else if (eventType === NotificationEventType.ORDER_CANCELLED) {
         priority = "CRITICAL";
       } else if (eventType === NotificationEventType.SHIPMENT_ASSIGNED) {
         priority = "MEDIUM";
       } else if (eventType === NotificationEventType.HIGH_VALUE_ORDER || eventType === NotificationEventType.LARGE_QTY_ORDER) {
         priority = "HIGH";
       }
    } else if (
      [
        NotificationEventType.LOW_STOCK, 
        NotificationEventType.OUT_OF_STOCK
      ].includes(eventType) 
    ) {
       category = "inventory";
       priority = eventType === NotificationEventType.OUT_OF_STOCK ? "CRITICAL" : "HIGH";
       if (variables.productId) {
         clickAction = `/inventory?product=${variables.productId}`;
         actions.push({ label: "Restock Now", url: `/inventory?editProduct=${variables.productId}&resolveNotificationId={NOTIFICATION_ID}` });
       }
    } else if (eventType === NotificationEventType.MULTIPLE_FAILED_LOGINS) {
       category = "security";
       priority = "CRITICAL";
    }

    // Load preferences for this event type
    const prefs = await this.notificationsService.getPreferences(userId);
    const eventPrefs = prefs.preferences[eventType] || { email: true, push: true, sms: false, browser: true };
    
    if (priority === "CRITICAL") {
       eventPrefs.push = true; // Always send push/in-app for critical
       eventPrefs.browser = true;
       eventPrefs.email = true;
    }

    if (!eventPrefs.email && !eventPrefs.push) {
      return { skipped: true, reason: "disabled_by_user_preferences" };
    }

    if (targetChannel === "all") {
      if (eventPrefs.email && !eventPrefs.push) targetChannel = "email";
      else if (!eventPrefs.email && eventPrefs.push) targetChannel = "push";
    }

    if (targetChannel === "email" && !env.ENABLE_EMAIL) return { skipped: true, reason: "email_disabled_globally" };
    if (targetChannel === "push" && !env.ENABLE_PUSH) return { skipped: true, reason: "push_disabled_globally" };
    if (targetChannel === "sms" && !env.ENABLE_SMS) return { skipped: true, reason: "sms_disabled_globally" };

    // Note: the category/priority variables are already determined above
    
    await this.notificationsService.notify(userId, title, body, targetChannel, clickAction, priority, category, actions.length ? actions : undefined, thumbnail);
    return { success: true };
  }

  /** DLQ handling once a job has exhausted its attempts. */
  private async onJobFailed(job: Job | undefined, err: Error) {
    if (job && job.attemptsMade >= job.opts.attempts!) {
      this.logger.error(`Notification job ${job.id} permanently failed: ${err.message}. Sent to DLQ.`);
      // Write permanently failed notification to NotificationAuditLog table
      if (job.data.userId) {
        await this.notificationsService.logAudit(
          job.data.userId,
          job.data.channel || "all",
          "failed",
          { errorMessage: `DLQ Exceeded Max Retries: ${err.message}` }
        );
      }
    }
  }

  /**
   * REDIS_ENABLED=false: run a job in this process after `delay`, retrying with
   * the same attempts/backoff as the BullMQ queue. Not persisted — pending jobs
   * are lost on restart.
   */
  private runLocal(name: string, data: any, delay = 0, attemptsMade = 0) {
    const job = { id: `local-${++this.localSeq}`, name, data, attemptsMade, opts: { attempts: LOCAL_ATTEMPTS } } as unknown as Job;
    const timer = setTimeout(async () => {
      try {
        await this.processJob(job);
      } catch (err: any) {
        if (attemptsMade + 1 < LOCAL_ATTEMPTS) {
          this.runLocal(name, data, LOCAL_BACKOFF_MS * 2 ** attemptsMade, attemptsMade + 1);
        } else {
          (job as any).attemptsMade = attemptsMade + 1;
          await this.onJobFailed(job, err).catch(() => {});
        }
      }
    }, delay);
    timer.unref?.();
  }

  async onModuleDestroy() {
    if (this.worker) await this.worker.close();
    if (this.queue) await this.queue.close();
    if (this.redisConnection) await this.redisConnection.quit();
  }

  /** Enqueue a job with priorities */
  async enqueue(
    userId: string,
    eventType: NotificationEventType,
    variables: Record<string, any>,
    options?: { channel?: NotifyChannel; delay?: number }
  ) {
    let priority = 4; // Default marketing / low stock
    if (eventType === NotificationEventType.NEW_ORDER) {
      priority = 1; // Highest priority
    } else if (eventType === NotificationEventType.PAYMENT_CAPTURED) {
      priority = 2;
    } else if (eventType === NotificationEventType.LOW_STOCK || eventType === NotificationEventType.OUT_OF_STOCK) {
      priority = 3;
    }

    if (!this.queue) {
      this.runLocal("send", { userId, eventType, variables, channel: options?.channel }, options?.delay);
      return;
    }

    try {
      const job = await withEnqueueTimeout(
        `enqueue ${eventType}`,
        this.queue.add(
          "send",
          { userId, eventType, variables, channel: options?.channel },
          {
            priority,
            delay: options?.delay,
          }
        ),
      );
      this.logger.log(`Enqueued job ${job.id} with priority ${priority}`);
      return job;
    } catch (err: any) {
      // Swallowed on purpose. A notification that cannot be queued is a lost
      // notification; it must never be a lost order.
      this.logger.error(`Failed to enqueue notification job: ${err.message}`);
    }
  }

  /** Phase 4: Enterprise Admin Broadcasting */
  async broadcastToAdmins(
    eventType: NotificationEventType,
    variables: Record<string, any>,
    options?: { channel?: NotifyChannel; delay?: number }
  ) {
    try {
      const cacheKey = "admin_user_ids";
      let adminIdsStr = await this.redisConnection.get(cacheKey);
      let adminIds: string[] = [];

      if (adminIdsStr) {
        adminIds = JSON.parse(adminIdsStr);
      } else {
        const admins = await this.userModel.findAll({ 
          where: { role: Role.ADMIN }, 
          attributes: ['id', 'isActive'] 
        });
        // Ignore inactive admins
        adminIds = admins.filter((a: any) => a.isActive !== false).map(a => a.id);
        await this.redisConnection.set(cacheKey, JSON.stringify(adminIds), "EX", 300); // Cache for 5 mins
      }

      for (const adminId of adminIds) {
        // Enqueue individual notifications and log audit internally
        await this.enqueue(adminId, eventType, variables, options);
      }
      
      // Fast WS emission to all connected admins
      this.trackingGateway.emitToAdmins("admin:notification:broadcast", { eventType, variables, ts: Date.now() });

      this.logger.log(`Broadcasted ${eventType} to ${adminIds.length} admins.`);
    } catch (err: any) {
      this.logger.error(`Failed to broadcast to admins: ${err.message}`);
    }
  }

  /** Phase 3: Enqueue dispatch for Delivery Retry System */
  async enqueueDispatch(userId: string, recordId: string, title: string, body: string, channel: string, priority: string) {
    if (!this.queue) {
      this.runLocal("dispatch", { userId, recordId, title, body, channel, priority });
      return;
    }
    try {
      await withEnqueueTimeout(
        "enqueue dispatch",
        this.queue.add("dispatch", { userId, recordId, title, body, channel, priority }, {
          priority: priority === "CRITICAL" ? 1 : priority === "HIGH" ? 2 : 3,
        }),
      );
    } catch (err: any) {
      this.logger.error(`Failed to enqueue dispatch job: ${err.message}`);
    }
  }

  /** Phase 3: Dedicated Dispatch Handler with DLQ and Retry Strategy */
  private async handleDispatchJob(job: Job) {
    const { userId, recordId, title, body, channel, priority } = job.data;
    
    await this.notificationsService.logAudit(userId, channel, "processing", { notificationId: recordId });
    
    const user = await this.notificationsService.getUserForDispatch(userId);
    if (!user) throw new Error("User not found");

    /*
     * Push and email are delivered together, not one as a retry of the other.
     *
     * This used to pick the channel from the retry count — push on attempts
     * 1-3, email on attempt 4, SMS on 5 — which made email unreachable
     * whenever push worked: the job completed on the first attempt and no mail
     * was ever sent. The only reason order emails arrived at all was that no
     * customer had a push token, so push failed three times and the job
     * escalated its way to email about seventy seconds later. The moment real
     * tokens start registering, that accident ends and the emails stop.
     *
     * A customer who has just placed an order should get the email because
     * they ordered something, not because a push notification failed.
     */
    const wantsPush = channel === "all" || channel === "push";
    const wantsEmail = channel === "all" || channel === "email";
    // SMS stays deliberately last-resort: CRITICAL only, and only once the
    // other channels have had their turn.
    const wantsSms = (channel === "all" || channel === "sms") && priority === "CRITICAL" && job.attemptsMade >= 1;

    const attempted: string[] = [];
    const delivered: string[] = [];
    const failures: Array<{ channel: string; error: string }> = [];

    const tryChannel = async (name: string, run: () => Promise<unknown>) => {
      attempted.push(name);
      try {
        await run();
        delivered.push(name);
      } catch (e) {
        // One channel failing must not deny the others. `sendPush` throws
        // "No Push Tokens" for any customer who has never granted permission,
        // which previously failed the whole job and took the email with it.
        failures.push({ channel: name, error: (e as Error).message });
      }
    };

    if (wantsPush) {
      await tryChannel("push", () => this.notificationsService.sendPush(userId, title, body, recordId));
    }

    if (wantsEmail) {
      // A phone-OTP account carries a synthetic address with no mailbox behind
      // it; sending there is a guaranteed bounce, not a delivery.
      if (isDeliverableEmail(user.email)) {
        await tryChannel("email", () => this.notificationsService.sendEmail(user.email, title, body, recordId, userId));
      } else {
        attempted.push("email:skipped-no-mailbox");
      }
    }

    if (wantsSms) {
      await tryChannel("sms", () => this.notificationsService.sendSms(user.phone || "", title, body, recordId, userId));
    }

    if (!attempted.length) {
      return { skipped: true, reason: "No channel applicable for this notification" };
    }

    if (!delivered.length) {
      // Nothing got through. Throwing hands the job back to the queue, which
      // retries with backoff — and on the next attempt SMS becomes eligible
      // for a CRITICAL notification. Succeeding here would silently drop it.
      const detail = failures.map((f) => `${f.channel}: ${f.error}`).join("; ");
      await this.notificationsService.logAudit(userId, channel, "failed", { notificationId: recordId, detail });
      if (failures.length) throw new Error(`All channels failed — ${detail}`);
      return { skipped: true, reason: attempted.join(", ") };
    }

    await this.notificationsService.logAudit(userId, delivered.join("+"), "delivered", { notificationId: recordId });
    return { success: true, delivered, failures };
  }

  /** Returns queue health state */
  async getHealth() {
    if (!this.queue) return { redis: "disabled", queue: "in-process", jobs: {} };
    try {
      const ping = await this.redisConnection.ping();
      const counts = await this.queue.getJobCounts();
      return {
        redis: ping === "PONG" ? "healthy" : "unhealthy",
        queue: "healthy",
        jobs: counts,
      };
    } catch {
      return { redis: "unhealthy", queue: "unhealthy", jobs: {} };
    }
  }

  private async handleIdempotencyAndDeduplication(key: string, userId: string, eventType: string, variables: any): Promise<{ skipped: boolean, reason?: string }> {
    // Phase 6.3 - Enterprise Atomic Lock using SET NX EX (24 hours)
    const result = await this.redisConnection.set(`idempotency:${key}`, "1", "EX", 86400, "NX");
    if (result === "OK") {
      return { skipped: false };
    } else {
      await this.notificationsService.incrementOccurrence(key);
      return { skipped: true, reason: "SKIPPED_DUPLICATE" };
    }
  }

  async enqueueEscalation(userId: string, notificationId: string, eventType: string) {
    if (!this.queue) {
      this.runLocal("escalate", { userId, notificationId, eventType }, 5 * 60 * 1000);
      return;
    }
    try {
      await withEnqueueTimeout(
        "enqueue escalation",
        this.queue.add("escalate", { userId, notificationId, eventType }, { delay: 5 * 60 * 1000 }), // 5 mins
      );
    } catch (err: any) {
      this.logger.error(`Failed to enqueue escalation job: ${err.message}`);
    }
  }

  private async handleEscalationJob(job: Job) {
    const { userId, notificationId, eventType } = job.data;
    await this.notificationsService.escalateIfUnread(userId, notificationId, eventType);
    return { success: true };
  }

  private async setupDigestJobs() {
    if (!this.queue) return;
    // Runs during onModuleInit. An unreachable Redis here used to stall boot
    // rather than start the app without its digests.
    try {
      await withEnqueueTimeout("register digest schedules", Promise.all([
        this.queue.add("digest:hourly", {}, { repeat: { pattern: "0 * * * *" } }),
        this.queue.add("digest:daily", {}, { repeat: { pattern: "0 0 * * *" } }),
        this.queue.add("digest:weekly", {}, { repeat: { pattern: "0 0 * * 0" } }),
      ]));
    } catch (err: any) {
      this.logger.error(`Could not register digest schedules: ${err.message}`);
    }
  }

  private async checkRateLimit(userId: string): Promise<boolean> {
    const window = process.env.NOTIFICATION_RATE_LIMIT_WINDOW ? parseInt(process.env.NOTIFICATION_RATE_LIMIT_WINDOW) : 60;
    const max = process.env.NOTIFICATION_RATE_LIMIT_MAX ? parseInt(process.env.NOTIFICATION_RATE_LIMIT_MAX) : 20;
    
    const key = `ratelimit:${userId}`;
    const count = await this.redisConnection.incr(key);
    if (count === 1) {
      await this.redisConnection.expire(key, window);
    }
    return count > max; 
  }
}
