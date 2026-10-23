import { Body, Controller, Get, Module, Param, Post, Query } from "@nestjs/common";
import { ReturnsService, ItemCondition } from "./returns.service";
import { PolicyResolutionService } from "./policy-resolution.service";
import { ExchangeFulfillmentService } from "./exchange-fulfillment.service";
import { ExchangeFulfillmentListener } from "./exchange-fulfillment.listener";
import { ExchangeLifecycleListener } from "./exchange-lifecycle.listener";
import { ReplacementRestockCron } from "./replacement-restock.cron";
import { DeliveryEngineModule } from "../delivery-engine/delivery-engine.module";
import { ReservationExpiryCron } from "./reservation-expiry.cron";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel, SequelizeModule, InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { Exchange, OrderItem, Return, ReturnMedia, ProductVariant, Product, ProductMedia, Brand, EarningWallet, LedgerEntry, AuditLog, User, ShopInventory, StockMovement, InventoryReservation, Order, OrderShipment, OrderStatusHistory } from "@/models";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { Role } from "@/common/enums/role.enum";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate } from "@/common/utils/crud.util";
import { ForbiddenException, NotFoundException } from "@/common/errors/http";
import { CreateReturnDto, CreateReturnBatchDto, ExchangeDto, RefundReturnDto, ReturnMediaDto, RejectReturnDto, InspectReturnDto, SchedulePickupDto, ConfirmPickupDto } from "@/common/dto/common.dto";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { NotificationsService } from "@/modules/notifications/notifications.service";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { NotificationQueueService } from "@/modules/notifications/notification.queue";
import { forwardRef, Inject } from "@nestjs/common";
import { OrdersModule } from "@/modules/orders/orders.module";
import { WalletModule } from "@/modules/wallet/wallet.module";
import { PromotionsModule } from "@/modules/promotions/promotions.module";

// ... existing controller code ...
@ApiTags("Returns")
@Controller("returns")
export class ReturnsController {
  constructor(
    @InjectConnection() private sequelize: Sequelize,
    @InjectModel(Return) private ret: typeof Return,
    @InjectModel(ReturnMedia) private media: typeof ReturnMedia,
    @InjectModel(Exchange) private ex: typeof Exchange,
    @InjectModel(OrderItem) private orderItem: typeof OrderItem,
    @InjectModel(EarningWallet) private wallet: typeof EarningWallet,
    @InjectModel(LedgerEntry) private ledger: typeof LedgerEntry,
    @InjectModel(AuditLog) private auditLogModel: typeof AuditLog,
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(ShopInventory) private inv: typeof ShopInventory,
    @InjectModel(StockMovement) private mov: typeof StockMovement,
    private notifications: NotificationsService,
    @Inject(forwardRef(() => NotificationQueueService))
    private queueService: NotificationQueueService,
    private returnsService: ReturnsService,
  ) {}

  /** A shop manager may only act on returns for items fulfilled by their shop. */
  private async assertReturnScope(u: JwtPayload, returnId: string): Promise<Return> {
    const ret = await this.ret.findByPk(returnId);
    if (!ret) throw new NotFoundException("NOT_FOUND", "Return not found");
    if (u.role === Role.SHOP_MANAGER) {
      const item = await this.orderItem.findByPk(ret.orderItemId);
      if (!item || item.shopId !== u.shopId) throw new ForbiddenException("AUTH_FORBIDDEN");
    }
    return ret;
  }

  @Post()
  async create(@CurrentUser() u: JwtPayload, @Body() b: CreateReturnDto) {
    return await this.returnsService.createReturn(u, b);
  }

  /**
   * Multi-item request: create a return (or same-variant replacement) for several
   * order items at once, each with its own quantity. Atomic — one ineligible line
   * rolls the whole batch back.
   */
  @Post("batch")
  async createBatch(@CurrentUser() u: JwtPayload, @Body() b: CreateReturnBatchDto) {
    return await this.returnsService.createReturnsBatch(u, b);
  }

  /**
   * Replacement stock for an order item, scoped to the fulfilling shop.
   * Backs the "Out of Stock" badge on the Request Replacement screen.
   */
  @Get("replacement-availability/:orderItemId")
  async replacementAvailability(
    @CurrentUser() u: JwtPayload,
    @Param("orderItemId") orderItemId: string,
    @Query("replacementVariantId") replacementVariantId?: string,
    @Query("quantity") quantity?: string,
  ) {
    return await this.returnsService.getReplacementAvailability(u, orderItemId, replacementVariantId, quantity ? Number(quantity) : undefined);
  }

  @Get("me")
  my(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    return paginate(this.ret, opts, { userId: u.sub }, [
      {
        model: OrderItem,
        include: [{
          model: ProductVariant,
          // paranoid:false — a return outlives its catalog entry. Without this a
          // soft-deleted product makes `variant` null, and the page's
          // `if (!orderItem || !product) return null` silently rendered NO card at
          // all: the customer lost sight of their own returns. Same fix already
          // applied to the admin list/detail.
          paranoid: false,
          include: [{
            model: Product,
            paranoid: false,
            include: [ProductMedia, Brand]
          }]
        }]
      },
      ReturnMedia,
      Exchange
    ]);
  }

  @RequirePermissions('returns.view')
  @Get("admin/grouped")
  async adminListGrouped(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    return await this.returnsService.getAdminReturnsGrouped(u, opts);
  }

  @RequirePermissions('returns.view')
  @Get("admin")
  // NB: must be the bare PageOptionsDto. An intersection type (`PageOptionsDto &
  // {...}`) erases to `Object` in design:paramtypes, so ValidationPipe skips
  // transformation — the class is never instantiated, `limit` stays a string and
  // the `offset` getter is missing, which silently disabled pagination.
  // PageOptionsDto already declares `q` and `status`.
  async adminList(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    return await this.returnsService.getAdminReturns(u, opts);
  }

  @RequirePermissions('returns.view')
  @Get("admin/:id")
  async adminDetail(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    return await this.returnsService.getAdminReturnDetail(u, id);
  }

  @Post(":id/media")
  async addMedia(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: ReturnMediaDto) {
    const ret = await this.ret.findOne({ where: { id, userId: u.sub } });
    if (!ret) throw new NotFoundException("NOT_FOUND", "Return not found");
    return this.media.create({ returnId: id, ...b } as any);
  }

  @RequirePermissions('returns.approve')
  @Post(":id/approve")
  async approve(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    return await this.returnsService.approveReturn(u, id);
  }

  @RequirePermissions('returns.reject')
  @Post(":id/reject")
  async reject(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: RejectReturnDto) {
    return await this.returnsService.rejectReturn(u, id, b.reason);
  }

  @RequirePermissions('returns.approve')
  @Post(":id/inspect")
  async inspect(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: InspectReturnDto) {
    return await this.returnsService.inspectReturn(u, id, b.status, b.comments, b.deductRestockingFee, b.condition);
  }

  @RequirePermissions('returns.approve')
  @Post(":id/schedule-pickup")
  async schedulePickup(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: SchedulePickupDto) {
    return await this.returnsService.schedulePickup(u, id, b?.scheduledAt);
  }

  @RequirePermissions('returns.approve')
  @Post(":id/pickup-confirm")
  async pickup(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: ConfirmPickupDto) {
    return await this.returnsService.confirmPickup(u, id, b.status);
  }

  @RequirePermissions('returns.refund')
  @Post(":id/refund")
  async refund(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: RefundReturnDto) {
    return await this.returnsService.processRefund(u, id, b);
  }

  @Post(":id/exchange")
  async exchange(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: ExchangeDto) {
    return await this.returnsService.processExchange(u, id, b);
  }
}

@Module({
  imports: [
    SequelizeModule.forFeature([
      Return, ReturnMedia, Exchange, OrderItem, ProductVariant, Product, ProductMedia, Brand, EarningWallet, LedgerEntry, AuditLog, User, ShopInventory, StockMovement,
      InventoryReservation, Order, OrderShipment, OrderStatusHistory
    ]),
    NotificationsModule,
    forwardRef(() => OrdersModule),
    WalletModule,
    // LoyaltyService — proportional points clawback when a return is refunded.
    PromotionsModule,
    // Provides DeliveryEngineService so replacement shipments get an ETA from the
    // same zone/SLA engine that normal orders use.
    DeliveryEngineModule
  ],
  controllers: [ReturnsController],
  providers: [ReturnsService, PolicyResolutionService, ExchangeFulfillmentService, ExchangeFulfillmentListener, ExchangeLifecycleListener, ReservationExpiryCron, ReplacementRestockCron],
  exports: [PolicyResolutionService, ExchangeFulfillmentService],
})
export class ReturnsModule {}
