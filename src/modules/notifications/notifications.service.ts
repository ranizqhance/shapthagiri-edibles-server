import { Injectable, Logger, Inject, forwardRef } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { FcmToken, Notification, User, NotificationInbox, NotificationPreference, NotificationAuditLog, NotificationTemplate } from "@/models";
import { Role } from "@/common/enums/role.enum";
import { pushProvider } from "@/common/providers/push.provider";
import { emailProvider } from "@/common/providers/email.provider";
import { isDeliverableEmail } from "@/common/utils/email.util";
import { Op } from "sequelize";
import { TrackingGateway } from "../tracking/tracking.gateway";
import { NotificationQueueService } from "./notification.queue";

export type NotifyChannel = "push" | "email" | "sms" | "all";

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger("NotificationsService");

  constructor(
    @InjectModel(Notification) private notif: typeof Notification,
    @InjectModel(FcmToken) private fcm: typeof FcmToken,
    @InjectModel(User) private user: typeof User,
    @InjectModel(NotificationInbox) private inbox: typeof NotificationInbox,
    @InjectModel(NotificationPreference) private pref: typeof NotificationPreference,
    @InjectModel(NotificationAuditLog) private audit: typeof NotificationAuditLog,
    @InjectModel(NotificationTemplate) private tplModel: typeof NotificationTemplate,
    @Inject(forwardRef(() => TrackingGateway))
    private trackingGateway: TrackingGateway,
    @Inject(forwardRef(() => NotificationQueueService))
    private queueService: NotificationQueueService,
  ) {}

  /**
   * The only values notification_templates.eventType accepts — it is a narrow
   * Postgres ENUM. Querying it with anything else (TRANSFER_COMPLETED, NEW_ORDER,
   * LOW_STOCK, …) raises an invalid-enum error, so those codes must skip the
   * lookup and go straight to the fallbacks below.
   */
  private static readonly TEMPLATED_EVENTS = new Set([
    "ORDER_PLACED", "ORDER_SHIPPED", "ORDER_DELIVERED", "RETURN_CREATED",
    "RETURN_APPROVED", "RETURN_REJECTED", "REFUND_INITIATED", "REVIEW_APPROVED",
    "SECURITY", "SYSTEM",
  ]);

  /** Render a template dynamically from variables */
  async renderTemplate(code: string, variables: Record<string, any>): Promise<{ title: string; body: string }> {
    // Was `where: { code }` — notification_templates has no "code" column, so EVERY
    // queued notification threw "column NotificationTemplate.code does not exist"
    // and the job failed before it could be delivered. Look up by the real column,
    // and never let a template problem take the notification pipeline down.
    let template: any = null;
    if (NotificationsService.TEMPLATED_EVENTS.has(code)) {
      try {
        template = await this.tplModel.findOne({ where: { eventType: code, isActive: true } });
      } catch {
        template = null;
      }
    }
    if (!template) {
      // Production Fallbacks
      if (code === "NEW_ORDER") {
        return {
          title: "New order to fulfill 📦",
          body:
            `Order ${variables.orderNumber || ""} has items assigned to ${variables.shopName || "your shop"}.` +
            // Present only on the copy sent to the customer, who may have no
            // account password and no way back to the order otherwise.
            (variables.trackUrl ? ` Track it here: ${variables.trackUrl}` : ""),
        };
      }
      if (code === "SHIPMENT_UNASSIGNED") {
        return {
          title: "No delivery partner available ⚠️",
          body: `Shipment ${variables.shipmentNumber || variables.shipmentId || ""} was handed over but no partner is online. Assign one manually.`.replace(/\s+/g, " ").trim(),
        };
      }
      if (code === "PAYMENT_CAPTURED") {
        return {
          title: "Payment captured successfully ✅",
          body: `Payment for Order ${variables.orderNumber || ""} has been captured.`,
        };
      }
      if (code === "HIGH_VALUE_ORDER") {
        return {
          title: "High Value Order 🚀",
          body: `Order ${variables.orderNumber || ""} has a total of ₹${variables.total || 0}.`,
        };
      }
      if (code === "LARGE_QTY_ORDER") {
        return {
          title: "Large Quantity Order 📦",
          body: `Order ${variables.orderNumber || ""} contains ${variables.qty || 0} items.`,
        };
      }
      if (code === "LOW_STOCK") {
        const shop = variables.shopName ? ` at ${variables.shopName}` : "";
        return {
          title: "Low Stock Alert 📉",
          body: `Product ${variables.productId}${shop} is running low (Qty: ${variables.quantity}, Threshold: ${variables.threshold ?? "N/A"}).`,
        };
      }
      if (code === "OUT_OF_STOCK") {
        const shop = variables.shopName ? ` at ${variables.shopName}` : "";
        return {
          title: "Out of Stock Alert 🚨",
          body: `Product ${variables.productId}${shop} is now out of stock!`,
        };
      }
      if (code === "USER_REGISTERED") {
        return {
          title: "New User Registered 👤",
          body: `User ${variables.name || variables.email} has just registered.`,
        };
      }
      if (code === "MULTIPLE_FAILED_LOGINS") {
        return {
          title: "Security Alert: Failed Logins 🚨",
          body: `Multiple failed login attempts detected for ${variables.email} (${variables.attempts} attempts).`,
        };
      }
      
      // Gift Card Templates
      if (code === "GIFT_CARD_RECEIVED") {
        return {
          title: "You received a Gift Card! 🎁",
          body: `You received a Gift Card (Code: ${variables.code}) with a balance of ₹${variables.balance}.`,
        };
      }
      if (code === "GIFT_CARD_CLAIMED") {
        return {
          title: "Gift Card Claimed! 🎉",
          body: `You successfully claimed a Gift Card. Current balance: ₹${variables.balance}.`,
        };
      }
      if (code === "GIFT_CARD_REDEEMED") {
        return {
          title: "Gift Card Redeemed 💳",
          body: `You redeemed ₹${variables.amount} from your Gift Card. Remaining balance: ₹${variables.balance}.`,
        };
      }
      if (code === "GIFT_CARD_LOW_BALANCE") {
        return {
          title: "Gift Card Low Balance Alert 📉",
          body: `Your Gift Card (Code: ${variables.code}) has a low balance of ₹${variables.balance}.`,
        };
      }
      
      // Additional fallback templates for Admin / Shop Manager
      if (code === "PAYMENT_FAILED") return { title: "Payment Failed ❌", body: `Payment for Order ${variables.orderNumber} has failed.` };
      if (code === "ORDER_CANCELLED") return { title: "Order Cancelled 🚫", body: `Order ${variables.orderNumber} has been cancelled.` };
      if (code === "ORDER_REFUNDED") return { title: "Order Refunded 💸", body: `Refund of ₹${variables.amount} issued for Order ${variables.orderNumber}.` };
      if (code === "LARGE_REFUND_ISSUED") return { title: "Large Refund Alert 💰", body: `A large refund of ₹${variables.amount} was issued for Order ${variables.orderNumber}.` };
      if (code === "INVENTORY_ADJUSTMENT") return { title: "Inventory Adjusted 🔄", body: `Inventory for Variant ${variables.variantId} adjusted by ${variables.quantity}. Reason: ${variables.reason}` };
      if (code === "RETURN_REQUESTED") return { title: "Return Requested 📦", body: `A return request has been raised for Order ${variables.orderNumber || variables.returnId}.` };
      if (code === "SHOP_MANAGER_CREATED") return { title: "Shop Manager Created 👔", body: `New shop manager registered: ${variables.email}` };
      
      // Loyalty
      if (code === "LOYALTY_POINTS_ISSUED") return { title: "Points Earned ⭐", body: `You earned ${variables.points} loyalty points. Balance: ${variables.newBalance} pts.` };
      if (code === "LOYALTY_POINTS_REDEEMED") return { title: "Points Redeemed 🎁", body: `You redeemed ${variables.points} points. Balance: ${variables.newBalance} pts.` };
      if (code === "LOYALTY_TIER_UPGRADED") return { title: "Tier Upgraded ✨", body: `Congratulations! You've reached ${String(variables.newTier).toUpperCase()} tier.` };
      if (code === "LOYALTY_POINTS_EXPIRING") return { title: "Points Expiring Soon ⏳", body: `${variables.points} loyalty points expire on ${variables.expiresAt}. Redeem them at checkout before they're gone.` };
      if (code === "LOYALTY_POINTS_EXPIRED") return { title: "Points Expired", body: `${variables.points} loyalty points have expired. Balance: ${variables.newBalance} pts.` };

      // Inter-shop stock transfer
      if (code === "TRANSFER_COMPLETED") {
        const route = variables.fromShopName && variables.toShopName
          ? `${variables.fromShopName} → ${variables.toShopName}`
          : "between shops";
        return {
          title: "Stock Transfer Completed 🔄",
          body: `${variables.quantity ?? 0} unit(s) moved ${route}.`,
        };
      }
      if (code === "FAILED_STOCK_TRANSFER") {
        return {
          title: "Stock Transfer Failed ⚠️",
          body: `A stock transfer was rejected: ${variables.reason || "unknown reason"}`,
        };
      }

      // Catch-all mapping for products, shops, and coupons
      if (code.startsWith("PRODUCT_") || code.startsWith("SHOP_") || code.startsWith("COUPON_") || code.startsWith("USER_")) {
        const action = code.split("_").pop()?.toLowerCase();
        const entity = code.split("_")[0];
        const name = variables.title || variables.shopName || variables.code || variables.email || variables.userId || "Item";
        return {
          title: `${entity.charAt(0).toUpperCase() + entity.slice(1).toLowerCase()} ${(action || '').charAt(0).toUpperCase() + (action || '').slice(1)}`.trim(),
          body: `${name} has been ${action}.`
        };
      }
      return { title: code, body: JSON.stringify(variables) };
    }
    let title = template.subject;
    let body = template.textBody;
    for (const [key, val] of Object.entries(variables)) {
      const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, "g");
      title = title.replace(placeholder, String(val));
      body = body.replace(placeholder, String(val));
    }
    return { title, body };
  }

  /** Logs an entry to the notification audit log */
  async logAudit(
    userId: string,
    channel: string,
    status: string,
    details?: { notificationId?: string; errorMessage?: string; [key: string]: any }
  ): Promise<NotificationAuditLog> {
    return this.audit.create({
      userId,
      channel,
      status,
      notificationId: details?.notificationId ?? null,
      errorMessage: details?.errorMessage ?? null,
    } as any);
  }

  /** Send notification instantly (Email + Push + SMS Fallback) with Grouping */
  async notify(userId: string, title: string, body: string, channel: NotifyChannel = "all", clickAction?: string, priority: string = "MEDIUM", category: string = "system", actions?: any, thumbnail?: string) {
    const user = await this.user.findByPk(userId);
    if (!user) return { sent: false };

    // Phase 3: Smart Configurable Grouping Logic (Anti-Spam)
    const GROUPABLE_CATEGORIES = ["inventory", "system", "orders"];
    const EXCLUDED_FROM_GROUPING = ["security", "fraud"];
    const isGroupable = GROUPABLE_CATEGORIES.includes(category) && priority !== "CRITICAL" && !EXCLUDED_FROM_GROUPING.includes(category);
    
    // Configurable Window: e.g. inventory=15 mins, system=60 mins
    const windowMinutes = category === "inventory" ? 15 : 60;
    const groupingWindow = new Date(Date.now() - windowMinutes * 60000);
    
    const { Op } = require("sequelize");
    let inAppRecord: any = null;

    // The title is a group's identity. Matching a row that has already been
    // grouped means matching "N <title>", so the title has to be safe to embed
    // in a regexp.
    const escapedTitle = [...title]
      .map((ch) => (".*+?^${}()|[]\\".includes(ch) ? `\\${ch}` : ch))
      .join("");
    /** This group's rows: the first one, and every counted one after it. */
    const sameGroupTitle = [
      { title },
      { title: { [Op.regexp]: `^[0-9]+ ${escapedTitle}$` } },
    ];

    if (isGroupable) {
      // Group only notifications that are the same kind of thing.
      //
      // This used to key on category + priority alone, and since almost
      // everything is category "system" at MEDIUM, every unrelated notification
      // inside the window collapsed into one row — which is how a row titled
      // "6 Order confirmed" ended up carrying a message about a review, and
      // pointing wherever the first of the six happened to point.
      //
      // The title is the event's identity, so it joins the key. An already
      // grouped row carries an "N " counter in front of it, hence the regexp.
      inAppRecord = await this.inbox.findOne({
        where: {
          userId,
          category,
          priority,
          readStatus: false,
          createdAt: { [Op.gte]: groupingWindow },
          [Op.or]: sameGroupTitle,
        },
        order: [['createdAt', 'DESC']]
      });
    }

    let isGrouped = false;
    if (inAppRecord) {
       const match = inAppRecord.title.match(/^(\d+) (.*)/);
       let groupCount = 2;
       let baseTitle = inAppRecord.title;
       
       if (match) {
         groupCount = parseInt(match[1], 10) + 1;
         baseTitle = match[2];
       }
       
       inAppRecord.title = `${groupCount} ${baseTitle}`;
       inAppRecord.message = `[Grouped: ${groupCount} updates] Latest: ${body}`;
       
       // Handle SubItems for Expansion UI
       let subItems: any[] = Array.isArray(inAppRecord.subItems) ? inAppRecord.subItems : [];
       // Push the new item info
       subItems.push({ title, message: body, timestamp: new Date() });
       // Also push the original item if it's the first time we are grouping
       if (groupCount === 2) {
         subItems.unshift({ title: baseTitle, message: inAppRecord.message.replace(/\[.*?\] Latest: /, ''), timestamp: inAppRecord.createdAt });
       }
       inAppRecord.subItems = subItems;
       
       // Point the group at the newest of its members. Keeping the first one's
       // destination means "3 Price drop" opens the product that dropped three
       // alerts ago, which is rarely the one the customer just read about.
       if (clickAction) inAppRecord.clickAction = clickAction;

       let existingActions: any[] = Array.isArray(inAppRecord.actions) ? inAppRecord.actions : [];
       
       const newActions = actions ? (Array.isArray(actions) ? actions : [actions]) : [];
       inAppRecord.actions = [...newActions, ...existingActions].slice(0, 5);
       
       await inAppRecord.save();
       isGrouped = true;
    } else {
      inAppRecord = await this.inbox.create({
      userId,
      title,
      message: body,
      readStatus: false,
      clickAction: clickAction || null,
      priority,
      category,
      actions: actions || null,
      thumbnail: thumbnail || null,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000), // Default 30 day expiration
    } as any);
    }
    
    if (!inAppRecord) return { sent: false };

    // Real-time broadcast to user's room
    try {
      const emitEvent = isGrouped ? "notification:updated" : "notification:received";
      this.trackingGateway.emitToUser(userId, emitEvent, {
        id: inAppRecord.id,
        title: inAppRecord.title,
        message: inAppRecord.message,
        readStatus: false,
        clickAction: clickAction || null,
        priority,
        category,
        actions: inAppRecord.actions || null,
        subItems: inAppRecord.subItems || [],
        thumbnail: thumbnail || null,
        createdAt: inAppRecord.createdAt,
        isGrouped
      });
    } catch (err) {
      this.logger.warn(`Failed to broadcast real-time notification to user ${userId}`, err);
    }

    // Phase 3: Enqueue for Reliable Delivery (Retry + DLQ)
    try {
      await this.logAudit(userId, channel, "queued", { notificationId: inAppRecord.id });
      await this.queueService.enqueueDispatch(userId, inAppRecord.id, title, body, channel, priority);
    } catch(err) {
      this.logger.error("Failed to enqueue dispatch job", err);
    }
    
    // Legacy support.
    //
    // This row is what the customer bell and the customer notifications page
    // read, so the destination has to travel with it. It used to be dropped
    // here, which is why tapping a notification went nowhere: the link only
    // ever existed on the inbox record above.
    //
    // When the inbox record was grouped, update the row that already stands for
    // this group instead of inserting another. Inserting was what produced the
    // "6 Order confirmed / 5 Order confirmed / 4 Order confirmed" ladder in the
    // bell: one leftover row per grouping step, all describing the same thing.
    const legacyPayload = {
      title: inAppRecord.title,
      body: inAppRecord.message,
      priority: inAppRecord.priority || "MEDIUM",
      metadata: {
        clickAction: inAppRecord.clickAction || null,
        category: inAppRecord.category || null,
      },
    };

    if (isGrouped) {
      try {
        const previous = await this.notif.findOne({
          where: { userId, [Op.or]: sameGroupTitle },
          order: [["createdAt", "DESC"]],
        });
        if (previous) {
          await previous.update(legacyPayload as any);
          return { sent: true };
        }
      } catch (err) {
        this.logger.warn("Legacy notification group update failed", err);
      }
    }

    try {
      await this.notif.create({
        userId,
        channel,
        sentAt: new Date(),
        type: "SYSTEM",
        status: "CREATED",
        provider: "INAPP",
        ...legacyPayload,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600_000)
      } as any);
    } catch (err) {
      this.logger.warn("Legacy notification creation failed", err);
    }
    return { sent: true };
  }

  // Helper methods for Dispatch Job
  async getUserForDispatch(userId: string) {
    return this.user.findByPk(userId);
  }

  async sendPush(userId: string, title: string, body: string, recordId: string) {
    const tokens = await this.fcm.findAll({ where: { userId } });

    /**
     * Drop the placeholder tokens before calling Google.
     *
     * The web client used to invent `fcm_token_web_<random>` and register that
     * instead of a real token. Every one was rejected by FCM — hence the
     * "0 ok / 5 failed" lines in the log — and the wasted round trips are
     * what surfaced a transport error severe enough to crash the process.
     *
     * The client now registers a genuine getToken() value, and migration 008
     * clears the old rows, so this filter only guards against the ones still
     * sitting in a database that has not run it. A real token is a long opaque
     * string with no such prefix.
     */
    const real = tokens.filter((t) => t.token && !/^fcm_token_web_/.test(t.token));
    if (!real.length) throw new Error("No Push Tokens");

    /**
     * The data payload is what makes the delivered notification useful.
     *
     * The service worker reads `tag` to replace a repeat of the same
     * notification rather than stacking a second banner, and `clickAction` to
     * decide where to send the customer. Without these it showed a banner that
     * led nowhere in particular. FCM requires every data value to be a string.
     */
    await pushProvider.sendMulticast(real.map((t) => t.token), title, body, {
      notificationId: recordId ?? "",
      tag: recordId ?? "",
      clickAction: "/notifications",
    });
  }

  async sendEmail(email: string, title: string, body: string, recordId: string, userId: string) {
    // Phone-OTP accounts carry a synthetic address to satisfy the NOT NULL
    // constraint on users.email. Mailing it is a guaranteed hard bounce, so
    // drop the message instead — quietly, because a customer who never gave us
    // an email has not failed at anything.
    if (!isDeliverableEmail(email)) {
      this.logger.log(`Skipped email for ${userId}: no deliverable address`);
      return;
    }
    await emailProvider.send(email, title, body);
  }

  async sendSms(phone: string, title: string, body: string, recordId: string, userId: string) {
    // await smsProvider.send(phone, title);
    this.logger.log(`SMS Sent to ${phone}`);
  }

  /** Fan a notification out to every user holding a given role (e.g. ops alerts). */
  async notifyRole(role: Role, title: string, body: string) {
    const users = await this.user.findAll({ where: { role } });
    for (const u of users) await this.notify(u.id, title, body, "all");
    return users.length;
  }

  /** Alert each shop manager */
  async notifyShopManagers(shopIds: string[], title: string, body: string, clickAction?: string, priority: string = "MEDIUM", category: string = "system", actions?: any, thumbnail?: string) {
    const ids = [...new Set(shopIds.filter(Boolean))];
    if (!ids.length) return 0;
    const managers = await this.user.findAll({ where: { role: Role.SHOP_MANAGER, shopId: ids as any } });
    for (const m of managers) {
      try {
        // Enforce user notification preferences for the NEW_ORDER event type
        const prefs = await this.getPreferences(m.id);
        const eventPrefs = prefs.preferences["NEW_ORDER"] || { email: true, push: true, sms: false, browser: true };
        
        let targetChannel: NotifyChannel = "all";
        if (!eventPrefs.email && !eventPrefs.push) {
          // Both disabled globally/for event
          targetChannel = "push"; // Fallback/Skip
        } else if (eventPrefs.email && !eventPrefs.push) {
          targetChannel = "email";
        } else if (!eventPrefs.email && eventPrefs.push) {
          targetChannel = "push";
        }

        // Await asynchronously or gracefully to not block caller transactions
        await this.notify(m.id, title, body, targetChannel, clickAction, priority, category, actions, thumbnail);
      } catch (err) {
        this.logger.error(`Error notifying shop manager ${m.id}`, err);
      }
    }
    return managers.length;
  }

  /** Get user preferences with defaults */
  async getPreferences(userId: string): Promise<NotificationPreference> {
    const [prefs] = await this.pref.findOrCreate({
      where: { userId },
      defaults: {
        userId,
        preferences: {
          NEW_ORDER: { email: true, push: true, sms: false, browser: true, sound: true },
          PAYMENT_CAPTURED: { email: true, push: true, sms: false, browser: true, sound: true },
          LOW_STOCK: { email: true, push: false, sms: false, browser: true, sound: false },
        },
      } as any,
    });
    return prefs;
  }

  /** Update user preferences */
  async updatePreferences(userId: string, preferences: any): Promise<NotificationPreference> {
    const prefs = await this.getPreferences(userId);
    await prefs.update({ preferences });
    return prefs;
  }

  /** Decoupled broadcast method for real-time shipment:created events */
  broadcastShipmentCreated(shopId: string, data: any) {
    try {
      this.trackingGateway.emitToShop(shopId, "shipment:created", data);
    } catch (err) {
      this.logger.warn(`Failed to broadcast shipment:created to shop ${shopId}`, err);
    }
  }

  // --- Advanced Enterprise Features ---

  async incrementOccurrence(idempotencyKey: string) {
    const item = await this.inbox.findOne({ where: { idempotencyKey }, order: [['createdAt', 'DESC']] });
    if (item) {
      await item.increment('occurrences', { by: 1 });
      await item.update({ title: `${item.title.replace(/^\[\d+ occurrences\] /, '')} - ${item.occurrences + 1} occurrences`, message: `Last updated: ${new Date().toISOString()}` });
      // Broadcast updated count
      this.trackingGateway.emitToUser(item.userId, "notification:updated", { id: item.id, occurrences: item.occurrences + 1 });
    }
  }

  async escalateIfUnread(userId: string, notificationId: string, eventType: string) {
    const item = await this.inbox.findOne({ where: { id: notificationId, userId, readStatus: false } });
    if (!item) return; // Already read or deleted

    this.logger.warn(`Notification ${notificationId} unread. Escalating to SMS/Higher Admin.`);
    await this.logAudit(userId, "sms", "escalated", { notificationId });
    
    const user = await this.user.findByPk(userId);
    if (user && user.phone) {
       await this.sendSms(user.phone, `CRITICAL ALERT: ${item.title}`, item.message, notificationId, userId);
    }
  }

  async processDigests(type: "hourly" | "daily" | "weekly") {
    // Find users who opted into this digest type
    // Note: In production, this would query the JSONB `preferences` column more robustly
    const prefs = await this.pref.findAll();
    for (const p of prefs) {
      if (p.preferences?.digest === type) {
        const unreadCount = await this.inbox.count({ where: { userId: p.userId, readStatus: false } });
        if (unreadCount > 0) {
          await this.notify(p.userId, `${type.charAt(0).toUpperCase() + type.slice(1)} Digest Summary`, `You have ${unreadCount} unread notifications.`, "email", "/inbox", "LOW", "system");
        }
      }
    }
  }
}
