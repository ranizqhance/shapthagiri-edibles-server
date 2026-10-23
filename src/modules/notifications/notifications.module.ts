import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query, MiddlewareConsumer, NestModule, forwardRef } from "@nestjs/common";
import { ApiBearerAuth, ApiTags, PartialType } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { FcmToken, Notification, NotificationTemplate, User, NotificationInbox, NotificationPreference, NotificationAuditLog } from "@/models";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate } from "@/common/utils/crud.util";
import { FcmTokenDto, SendNotificationDto, TemplateDto, SnoozeDto, AssignInboxDto, InboxBulkDto, NotificationPrefsDto } from "@/common/dto/common.dto";
import { NotificationsService, NotifyChannel } from "./notifications.service";
import { NotificationQueueService } from "./notification.queue";
import { SystemEventObserver } from "./system-event.observer";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { Op } from "sequelize";
import { BadRequestException, NotFoundException } from "@/common/errors/http";
import { emailProvider } from "@/common/providers/email.provider";
import { isDeliverableEmail } from "@/common/utils/email.util";
import { BRAND } from "@/common/brand";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsModule } from "../payments/payments.module";
import { TrackingModule } from "../tracking/tracking.gateway";
import { IsOptional, IsString } from "class-validator";

/*
 * PartialType(), not Partial<>.
 *
 * `Partial<T>` is a TypeScript-only construct: it erases to `Object` at
 * runtime, so Nest sees no DTO class, ValidationPipe skips the body entirely,
 * and `whitelist: true` strips nothing. These routes were accepting arbitrary
 * JSON straight into a model update. `PartialType` from @nestjs/swagger keeps
 * the validation metadata and only makes the fields optional.
 */
export class UpdateTemplateDto extends PartialType(TemplateDto) {}

export class InboxQueryDto extends PageOptionsDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() tags?: string;
  @IsOptional() @IsString() priority?: string;
}

@ApiTags("Notifications")
@ApiBearerAuth()
@Controller("notifications")
export class NotificationsController {
  constructor(
    private notifications: NotificationsService,
    @InjectModel(Notification) private notif: typeof Notification,
    @InjectModel(NotificationTemplate) private tpl: typeof NotificationTemplate,
    @InjectModel(FcmToken) private fcm: typeof FcmToken,
    @InjectModel(User) private user: typeof User,
    @InjectModel(NotificationInbox) private inboxModel: typeof NotificationInbox,
    @InjectModel(NotificationAuditLog) private auditModel: typeof NotificationAuditLog,
  ) {}

  @Get("me") my(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) { return paginate(this.notif, opts, { userId: u.sub }); }
  @Post("me/:id/read") async read(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    await this.notif.update({ readAt: new Date() }, { where: { id, userId: u.sub } }); return { read: true };
  }
  /** Mark every unread notification for the current user as read (one query). */
  @Post("me/read-all") async readAll(@CurrentUser() u: JwtPayload) {
    const [count] = await this.notif.update({ readAt: new Date(), isRead: true }, { where: { userId: u.sub, readAt: null as any } });
    return { read: true, count };
  }
  @Post("me/fcm") async fcmReg(@CurrentUser() u: JwtPayload, @Body() b: FcmTokenDto) {
    await this.fcm.upsert({ userId: u.sub, ...b } as any); return { registered: true };
  }
  @RequirePermissions("notifications.view") @Get("templates") templates() { return this.tpl.findAll(); }
  @RequirePermissions("notifications.configure") @Post("templates") createTpl(@Body() b: TemplateDto) { return this.tpl.create(b as any); }
  @RequirePermissions("notifications.configure") @Patch("templates/:id") async updateTpl(@Param("id") id: string, @Body() b: UpdateTemplateDto) {
    await this.tpl.update(b, { where: { id } });
    return this.tpl.findByPk(id);
  }
  @RequirePermissions("notifications.configure") @Delete("templates/:id") async deleteTpl(@Param("id") id: string) {
    await this.tpl.destroy({ where: { id } });
    return { deleted: true };
  }

  @RequirePermissions("notifications.send") @Post("send") send(@Body() b: SendNotificationDto) {
    return this.notifications.notify(b.userId, b.title, b.body, b.channel as NotifyChannel);
  }

  /**
   * Prove the mail configuration works, without placing an order to find out.
   *
   * Whether a deployment has GMAIL_USER / GMAIL_APP_PASSWORD set is otherwise
   * unknowable from outside the container: with them missing the provider sits
   * in stub mode, logs "[Email stub]" and returns success, so every layer above
   * it reports a delivery that never happened.
   *
   * Sends only to the caller's own address — never a supplied one, so this
   * cannot be used to send mail to a third party.
   */
  @RequirePermissions("notifications.send")
  @Post("test-email")
  async testEmail(@CurrentUser() u: JwtPayload) {
    const me = await this.user.findByPk(u.sub);
    if (!me) throw new NotFoundException("NOT_FOUND", "User not found");
    if (!isDeliverableEmail(me.email)) {
      throw new BadRequestException(
        "BAD_REQUEST",
        "Your account has no real mailbox — a phone-OTP account carries a synthetic address."
      );
    }

    const sentAt = new Date().toISOString();
    const result = await emailProvider.sendMail({
      to: me.email,
      subject: `${BRAND.name} — email delivery test`,
      html: `<p>Email delivery is working.</p><p>Sent ${sentAt} from the ${BRAND.name} API.</p>`,
      text: `Email delivery is working. Sent ${sentAt} from the ${BRAND.name} API.`,
    });

    // `stub: true` is the answer that matters: it means no credentials are
    // loaded and nothing was actually sent.
    return {
      ...result,
      to: me.email,
      configured: !result.stub,
      hint: result.stub
        ? "No mail credentials loaded — set GMAIL_USER and GMAIL_APP_PASSWORD on this service and restart."
        : "Sent. Check the inbox, and the spam folder.",
    };
  }

  // --- Notification Inbox & Preferences Endpoints ---

  @Get("inbox")
  async getInbox(@CurrentUser() u: JwtPayload, @Query() opts: InboxQueryDto) {
    try {
      const where: any = { userId: u.sub };
      if (opts.q) {
        where[Op.or] = [
          { title: { [Op.iLike]: `%${opts.q}%` } },
          { message: { [Op.iLike]: `%${opts.q}%` } },
          { actions: { [Op.contains]: [{ label: opts.q }] } } // Basic JSONB search
        ];
      }
      if (opts.category) where.category = opts.category;
      if (opts.priority) where.priority = opts.priority;
      // Exclude archived by default unless specifically requested
      if (opts.tags !== 'archived') where.archivedAt = null;

      return await paginate(this.inboxModel, opts, where);
    } catch (error) {
      console.error("GET INBOX ERROR:", error);
      throw error;
    }
  }

  @Get("inbox/summary")
  async getSummary(@CurrentUser() u: JwtPayload) {
    const userId = u.sub;
    const [critical, unread, today, failed] = await Promise.all([
      this.inboxModel.count({ where: { userId, priority: 'CRITICAL', readStatus: false } }),
      this.inboxModel.count({ where: { userId, readStatus: false, archivedAt: null } }),
      this.inboxModel.count({ where: { userId, createdAt: { [Op.gte]: new Date(new Date().setHours(0,0,0,0)) } } }),
      this.auditModel.count({ where: { userId, status: 'failed' } })
    ]);
    return { critical, unread, today, failed };
  }

  @Patch("inbox/:id/read")
  async readInboxItem(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const item = await this.inboxModel.findOne({ where: { id, userId: u.sub } });
    if (!item) throw new NotFoundException("NOT_FOUND", "Notification not found");
    await item.update({ readStatus: true });
    await this.notifications.logAudit(u.sub, "in_app", "opened", { notificationId: id });
    return { success: true };
  }

  @Patch("inbox/:id/click")
  async clickInboxItem(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const item = await this.inboxModel.findOne({ where: { id, userId: u.sub } });
    if (!item) throw new NotFoundException("NOT_FOUND", "Notification not found");
    await this.notifications.logAudit(u.sub, "in_app", "clicked", { notificationId: id });
    return { success: true };
  }

  @Patch("inbox/read-all")
  async readAllInboxItems(@CurrentUser() u: JwtPayload) {
    await this.inboxModel.update({ readStatus: true }, { where: { userId: u.sub } });
    return { success: true };
  }

  @Delete("inbox/:id")
  async deleteInboxItem(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const item = await this.inboxModel.findOne({ where: { id, userId: u.sub } });
    if (!item) throw new NotFoundException("NOT_FOUND", "Notification not found");
    await item.destroy();
    return { success: true };
  }

  // --- Advanced Actions ---

  @Patch("inbox/:id/snooze")
  async snoozeInboxItem(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() snooze: SnoozeDto) {
    const minutes = snooze.durationMinutes;
    const item = await this.inboxModel.findOne({ where: { id, userId: u.sub } });
    if (!item) throw new NotFoundException();
    const snoozeUntil = new Date(Date.now() + (minutes * 60000));
    await item.update({ snoozeUntil });
    await this.notifications.logAudit(u.sub, "in_app", "snoozed", { notificationId: id, snoozeUntil });
    return { success: true, snoozeUntil };
  }

  @Patch("inbox/:id/assign")
  async assignInboxItem(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() assign: AssignInboxDto) {
    const assignedTo = assign.assignedTo;
    const item = await this.inboxModel.findOne({ where: { id, userId: u.sub } });
    if (!item) throw new NotFoundException();
    await item.update({ assignedTo });
    await this.notifications.logAudit(u.sub, "in_app", "assigned", { notificationId: id, assignedTo });
    return { success: true };
  }

  @Patch("inbox/:id/resolve")
  async resolveInboxItem(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const item = await this.inboxModel.findOne({ where: { id, userId: u.sub } });
    if (!item) throw new NotFoundException();
    await item.update({ resolvedAt: new Date() });
    await this.notifications.logAudit(u.sub, "in_app", "resolved", { notificationId: id });
    return { success: true };
  }

  @Patch("inbox/:id/archive")
  async archiveInboxItem(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const item = await this.inboxModel.findOne({ where: { id, userId: u.sub } });
    if (!item) throw new NotFoundException();
    await item.update({ archivedAt: new Date() });
    await this.notifications.logAudit(u.sub, "in_app", "archived", { notificationId: id });
    return { success: true };
  }

  @Post("inbox/bulk")
  async bulkOperations(@CurrentUser() u: JwtPayload, @Body() body: InboxBulkDto) {
    if (!body.ids?.length) return { count: 0 };
    const where = { id: { [Op.in]: body.ids }, userId: u.sub };
    
    if (body.action === 'markRead') await this.inboxModel.update({ readStatus: true }, { where });
    else if (body.action === 'archive') await this.inboxModel.update({ archivedAt: new Date() }, { where });
    else if (body.action === 'delete') await this.inboxModel.destroy({ where });
    
    return { success: true, action: body.action, count: body.ids.length };
  }

  @Get("inbox/:id/timeline")
  async getTimeline(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    return this.auditModel.findAll({ where: { notificationId: id, userId: u.sub }, order: [['createdAt', 'ASC']] });
  }

  @Get("preferences")
  async getPrefs(@CurrentUser() u: JwtPayload) {
    return this.notifications.getPreferences(u.sub);
  }

  @Patch("preferences")
  async updatePrefs(@CurrentUser() u: JwtPayload, @Body() b: NotificationPrefsDto) {
    return this.notifications.updatePreferences(u.sub, b);
  }
}

@Module({
  imports: [
    SequelizeModule.forFeature([Notification, NotificationTemplate, FcmToken, User, NotificationInbox, NotificationPreference, NotificationAuditLog]),
    forwardRef(() => OrdersModule),
    forwardRef(() => PaymentsModule),
    TrackingModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationQueueService, SystemEventObserver],
  exports: [NotificationsService, NotificationQueueService],
})
export class NotificationsModule implements NestModule {
  constructor(private queueService: NotificationQueueService) {}

  configure(consumer: MiddlewareConsumer) {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath("/admin/queues");

    const queue = this.queueService.queue;
    if (queue) {
      createBullBoard({
        queues: [new BullMQAdapter(queue)],
        serverAdapter: serverAdapter,
      });
      consumer.apply(serverAdapter.getRouter()).forRoutes("/admin/queues");
    }
  }
}
