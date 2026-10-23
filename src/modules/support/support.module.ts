import { Body, Controller, Get, Module, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { Dispute, SupportTicket, TicketMessage, User, Order } from "@/models";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { Role } from "@/common/enums/role.enum";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate } from "@/common/utils/crud.util";
import { ForbiddenException, NotFoundException } from "@/common/errors/http";
import { hasPermission, shopScope } from "@/common/utils/permission.util";
import { TicketAssignDto, TicketDto, TicketMessageDto } from "@/common/dto/common.dto";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { NotificationsService } from "@/modules/notifications/notifications.service";
import { NotificationQueueService } from "@/modules/notifications/notification.queue";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { forwardRef, Inject } from "@nestjs/common";
import { OrderShipment } from "@/models";



@ApiTags("Support")
@ApiBearerAuth()
@Controller("support")
export class SupportController {
  constructor(
    @InjectModel(SupportTicket) private ticket: typeof SupportTicket,
    @InjectModel(TicketMessage) private msg: typeof TicketMessage,
    @InjectModel(Dispute) private dispute: typeof Dispute,
    private notifications: NotificationsService,
    @Inject(forwardRef(() => NotificationQueueService))
    private queueService: NotificationQueueService,
  ) {}
  @Post("tickets") async create(@CurrentUser() u: JwtPayload, @Body() b: TicketDto) {
    // A ticket may only point at the caller's own order: staff open the linked
    // order from the ticket, so a stranger's id here put their order in front
    // of support under someone else's name.
    if (b.orderId && !(await Order.findOne({ where: { id: b.orderId, userId: u.sub }, attributes: ["id"] }))) {
      throw new NotFoundException("NOT_FOUND", "Order not found");
    }
    return this.ticket.create({ userId: u.sub, ...b } as any);
  }
  @Get("tickets/me") my(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) { return paginate(this.ticket, opts, { userId: u.sub }); }
  @ApiBearerAuth()
  @Get("tickets/:id/messages")
  async getMessages(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const ticket = await this.ticket.findByPk(id);
    if (!ticket) throw new NotFoundException("NOT_FOUND", "Ticket not found");
    if (ticket.userId !== u.sub && !hasPermission(u, "support.view")) throw new NotFoundException("NOT_FOUND", "Ticket not found");
    return this.msg.findAll({
      where: { ticketId: id },
      order: [["createdAt", "ASC"]],
      limit: 500, // a thread, bounded
    });
  }
  @Post("tickets/:id/message") async postMsg(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: TicketMessageDto) {
    const ticket = await this.ticket.findByPk(id);
    if (!ticket) throw new NotFoundException("NOT_FOUND", "Ticket not found");
    // Only the ticket owner or support staff may post into a ticket thread.
    if (ticket.userId !== u.sub && !hasPermission(u, "support.view")) throw new NotFoundException("NOT_FOUND", "Ticket not found");
    return this.msg.create({ ticketId: id, senderId: u.sub, body: b.body } as any);
  }
  @RequirePermissions("support.view") @Get("admin/tickets") all(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    // Shop accounts handle tickets about their own shop's orders, not every
    // customer's conversation on the platform.
    const shop = shopScope(u);
    const seq = this.ticket.sequelize!;
    const where = shop
      ? { orderId: { [Op.in]: seq.literal(`(SELECT "orderId" FROM order_shipments WHERE "shopId" = ${seq.escape(shop)})`) } }
      : {};
    return paginate(this.ticket, opts, where, [
      { model: User, as: "user" },
      { model: Order, as: "order" }
    ]);
  }
  @RequirePermissions("support.view") @Post("admin/tickets/:id/assign") async assign(@Param("id") id: string, @Body() b: TicketAssignDto) {
    await this.ticket.update({ assignedTo: b.agentId }, { where: { id } });
    await this.notifications.notify(b.agentId, "Ticket assigned to you", `Support ticket ${id} has been assigned to you.`);
    return { assigned: true };
  }
  @RequirePermissions("support.close") @Post("admin/tickets/:id/resolve") async resolve(@Param("id") id: string) {
    await this.ticket.update({ status: "resolved" }, { where: { id } });
    const t = await this.ticket.findByPk(id);
    if (t) await this.notifications.notify(t.userId, "Your ticket was resolved", `Support ticket "${t.subject}" has been marked resolved.`);
    return { resolved: true };
  }
  // NOTE: Disputes moved to the dedicated DisputesModule (`/disputes`), which
  // implements the full customer → support → admin → finance → resolution
  // workflow. Support tickets remain here.
}

@Module({
  imports: [SequelizeModule.forFeature([SupportTicket, TicketMessage, Dispute, User, Order]), NotificationsModule],
  controllers: [SupportController],
})
export class SupportModule {}
