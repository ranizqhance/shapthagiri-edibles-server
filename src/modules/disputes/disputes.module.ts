import { Body, Controller, Get, Module, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { SequelizeModule } from "@nestjs/sequelize";
import { Dispute, DisputeMessage, Order, User, Payment, PaymentRefund, AuditLog } from "@/models";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { DisputesService } from "./disputes.service";
import {
  CreateDisputeDto, DisputeMessageDto, AssignDisputeDto, EscalateDisputeDto, RejectDisputeDto, ResolveDisputeDto, ChargebackDto,
} from "@/common/dto/common.dto";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { WalletModule } from "@/modules/wallet/wallet.module";
import { PromotionsModule } from "@/modules/promotions/promotions.module";

@ApiTags("Disputes")
@ApiBearerAuth()
@Controller("disputes")
export class DisputesController {
  constructor(private readonly svc: DisputesService) {}

  // ── Customer + staff ──
  @Post()
  create(@CurrentUser() u: JwtPayload, @Body() b: CreateDisputeDto) {
    return this.svc.createDispute(u, b);
  }

  @Get("me")
  mine(@CurrentUser() u: JwtPayload, @Query() opts: any) {
    return this.svc.myDisputes(u, opts);
  }

  // ── Staff queue ──
  @RequirePermissions("disputes.view")
  @Get()
  list(@CurrentUser() u: JwtPayload, @Query() opts: any) {
    return this.svc.list(u, opts);
  }

  // Inbound payment-gateway chargeback → Dispute. The endpoint a gateway webhook
  // calls; also usable by Finance to log a chargeback manually. Idempotent.
  @RequirePermissions("disputes.resolve")
  @Post("chargeback")
  chargeback(@CurrentUser() u: JwtPayload, @Body() b: ChargebackDto) {
    return this.svc.ingestChargeback(u.sub, b);
  }

  // Ops: run the SLA breach sweep immediately (the same logic the 10-min cron
  // runs) — for manual triggering / verification.
  @RequirePermissions("disputes.escalate")
  @Post("admin/run-sla-sweep")
  runSlaSweep() {
    return this.svc.autoEscalateOverdue();
  }

  @Get(":id")
  get(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    return this.svc.getOne(u, id);
  }

  @Get(":id/messages")
  messages(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    return this.svc.getMessages(u, id);
  }

  @Post(":id/messages")
  postMessage(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: DisputeMessageDto) {
    return this.svc.postMessage(u, id, b);
  }

  // ── Triage / workflow (staff) ──
  @RequirePermissions("disputes.view")
  @Post(":id/assign")
  assign(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: AssignDisputeDto) {
    return this.svc.assign(u, id, b.agentId);
  }

  @RequirePermissions("disputes.view")
  @Post(":id/review")
  review(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    return this.svc.startReview(u, id);
  }

  @RequirePermissions("disputes.view")
  @Post(":id/request-info")
  requestInfo(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: { note?: string }) {
    return this.svc.requestInfo(u, id, b?.note);
  }

  @RequirePermissions("disputes.escalate")
  @Post(":id/escalate")
  escalate(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: EscalateDisputeDto) {
    return this.svc.escalate(u, id, b?.reason);
  }

  @RequirePermissions("disputes.resolve")
  @Post(":id/reject")
  reject(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: RejectDisputeDto) {
    return this.svc.reject(u, id, b.reason);
  }

  // Resolution (incl. financial) — Support for low-value non-gateway remedies;
  // Admin/Finance for gateway/gift-card or over-threshold (enforced in service).
  @RequirePermissions("disputes.resolve")
  @Post(":id/resolve")
  resolve(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: ResolveDisputeDto) {
    return this.svc.resolve(u, id, b);
  }
}

@Module({
  imports: [
    SequelizeModule.forFeature([Dispute, DisputeMessage, Order, User, Payment, PaymentRefund, AuditLog]),
    NotificationsModule,
    WalletModule,
    PromotionsModule, // GiftCardService
  ],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
