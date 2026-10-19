import { Body, Controller, Get, Module, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { SequelizeModule } from "@nestjs/sequelize";
import { IsNumber, IsOptional, IsString, IsIn, IsInt, Min } from "class-validator";
import { CustomerWallet, WalletTransaction, AuditLog } from "@/models";
import { WalletService } from "./wallet.service";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { PageOptionsDto } from "@/common/dto/page-options.dto";

class WalletAdjustDto {
  @IsNumber() @Min(0.01) amount!: number;
  @IsOptional() @IsString() reason?: string;
  // Credit category (defaults to MANUAL_CREDIT for admin credits) + optional expiry.
  @IsOptional() @IsIn(["MANUAL_CREDIT", "CASHBACK", "BONUS", "REFUND", "GIFT_CARD"]) category?: string;
  @IsOptional() @IsInt() @Min(1) expiresInDays?: number;
}

@ApiTags("Wallet")
@ApiBearerAuth()
@Controller("wallet")
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  /* ── Customer ── */

  /** The signed-in customer's wallet balance. */
  @Get("me")
  me(@CurrentUser() u: JwtPayload) {
    return this.wallet.getBalance(u.sub);
  }

  /** The signed-in customer's wallet transaction history (paginated). */
  @Get("me/transactions")
  myTransactions(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    return this.wallet.listTransactions(u.sub, opts);
  }

  /* ── Admin ── */

  @RequirePermissions('wallet.view')
  @Get("admin/:userId")
  adminView(@Param("userId") userId: string, @Query() opts: PageOptionsDto) {
    return this.wallet.adminView(userId, opts);
  }

  @RequirePermissions('wallet.credit')
  @Post("admin/:userId/credit")
  async adminCredit(@CurrentUser() u: JwtPayload, @Param("userId") userId: string, @Body() b: WalletAdjustDto) {
    await this.wallet.credit(userId, b.amount, {
      type: "credit", category: (b.category as any) ?? "MANUAL_CREDIT", expiresInDays: b.expiresInDays ?? null,
      actorId: u.sub, reason: b.reason ?? "Admin credit",
    });
    return this.wallet.getBalance(userId);
  }

  @RequirePermissions('wallet.debit')
  @Post("admin/:userId/debit")
  async adminDebit(@CurrentUser() u: JwtPayload, @Param("userId") userId: string, @Body() b: WalletAdjustDto) {
    await this.wallet.debit(userId, b.amount, { actorId: u.sub, reason: b.reason ?? "Admin debit" });
    return this.wallet.getBalance(userId);
  }
}

@Module({
  imports: [SequelizeModule.forFeature([CustomerWallet, WalletTransaction, AuditLog])],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
