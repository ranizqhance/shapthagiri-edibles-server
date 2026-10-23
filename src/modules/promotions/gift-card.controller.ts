import { csvCell } from "@/common/utils/csv.util";
import { Throttle } from "@nestjs/throttler";
import { LIMITS } from "@/common/security/throttle";
import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, BadRequestException } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { GiftCardService } from "./gift-card.service";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { CreateGiftCardDto, UpdateGiftCardDto, RechargeGiftCardDto, ApplyGiftCardDto, BulkUpdateStatusDto, BulkRechargeDto } from "@/common/dto/gift-card.dto";

@ApiTags("Gift Cards")
@ApiBearerAuth()
@Controller()
export class GiftCardController {
  constructor(private readonly giftCardService: GiftCardService) {}

  // --- Admin APIs ---

  @Get(["admin/gift-cards/dashboard-summary", "promotions/gift-cards/dashboard-summary", "admin/gift-cards/summary", "promotions/gift-cards/summary"])
  @RequirePermissions('giftcards.view')
  async getDashboardSummary() {
    return this.giftCardService.getDashboardSummary();
  }

  @Get(["admin/gift-cards", "promotions/gift-cards"])
  @RequirePermissions('giftcards.view')
  async listGiftCards(@Query("limit") limit: string) {
    return this.giftCardService.listGiftCards(Number(limit) || 50);
  }

  @Post(["admin/gift-cards", "promotions/gift-cards"])
  @RequirePermissions('giftcards.create')
  async createGiftCard(@CurrentUser() u: JwtPayload, @Body() data: CreateGiftCardDto) {
    return this.giftCardService.createGiftCard(data, u.sub);
  }

  @Patch(["admin/gift-cards/:id", "promotions/gift-cards/:id"])
  @RequirePermissions('giftcards.edit')
  async updateGiftCard(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() data: UpdateGiftCardDto) {
    return this.giftCardService.updateGiftCardStatus(id, data, u.sub);
  }

  @Post(["admin/gift-cards/:id/recharge", "promotions/gift-cards/:id/recharge"])
  @RequirePermissions('giftcards.edit')
  async rechargeGiftCard(
    @CurrentUser() u: JwtPayload, 
    @Param("id") id: string, 
    @Body() data: RechargeGiftCardDto,
    @Query("idempotencyKey") idempotencyKey?: string
  ) {
    return this.giftCardService.rechargeGiftCard(id, data, u.sub, idempotencyKey);
  }

  // --- Customer APIs ---

  @Throttle(LIMITS.voucher)
  @Post("promotions/gift-cards/validate")
  async validateGiftCard(@CurrentUser() u: JwtPayload, @Body() data: ApplyGiftCardDto) {
    if (!data.code) throw new BadRequestException("Code is required");
    const gc = await this.giftCardService.validateForCart(data.code, u.sub, 0);
    return {
       valid: true,
       // id lets the buy-now checkout apply the card by its UUID (PlaceOrderDto.giftCardId
       // is @IsUUID); without it the flow fell back to the code and failed validation.
       id: gc.id,
       balance: gc.balance,
       currency: gc.currency,
       expiresAt: gc.expiresAt,
    };
  }

  @Get("promotions/gift-cards/my-cards")
  async getMyGiftCards(
    @CurrentUser() u: JwtPayload,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("status") status?: string,
    @Query("search") search?: string
  ) {
    return this.giftCardService.getMyGiftCards(u.sub, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      status,
      search
    });
  }

  @Throttle(LIMITS.voucher)
  @Post("promotions/gift-cards/claim")
  async claimGiftCard(
    @CurrentUser() u: JwtPayload,
    @Body() data: ApplyGiftCardDto
  ) {
    if (!data.code) throw new BadRequestException("Code is required");
    return this.giftCardService.claimGiftCard(data.code, u.sub);
  }

  @Get(["admin/gift-cards/:id", "promotions/gift-cards/:id"])
  @RequirePermissions('giftcards.view')
  async getGiftCardDetails(@Param("id") id: string) {
    return this.giftCardService.getGiftCardDetails(id);
  }

  @Post(["admin/gift-cards/bulk/status", "promotions/gift-cards/bulk/status"])
  @RequirePermissions('giftcards.disable')
  async bulkUpdateStatus(@CurrentUser() u: JwtPayload, @Body() data: BulkUpdateStatusDto) {
    return this.giftCardService.bulkUpdateStatus(data.ids, data.status, u.sub, data.notes);
  }

  @Post(["admin/gift-cards/bulk/recharge", "promotions/gift-cards/bulk/recharge"])
  @RequirePermissions('giftcards.edit')
  async bulkRecharge(@CurrentUser() u: JwtPayload, @Body() data: BulkRechargeDto) {
    return this.giftCardService.bulkRecharge(data.payloads, u.sub, data.notes);
  }

  @Throttle(LIMITS.export)
  @Get(["admin/gift-cards/export/csv", "promotions/gift-cards/export/csv"])
  @RequirePermissions('giftcards.view')
  async exportCsv(@Query("limit") limit: string) {
    const res = await this.giftCardService.listGiftCards(Number(limit) || 1000);

    /*
     * Quoted, and guarded against spreadsheet formula injection.
     *
     * Fields were interpolated raw, so a comma or a quote in any of them
     * broke the column alignment, and a value starting with = + - or @ is
     * executed as a formula when the file is opened in Excel or Sheets,
     * which is where an export like this always ends up. Gift-card codes
     * and customer emails are in this file, so it is worth getting right.
     */
    const cell = csvCell;

    const header = ["Code", "Type", "Balance", "Status", "ExpiresAt", "CustomerEmail"];
    const rows = res.items.map((item: any) => [
      item.code, item.type, item.balance, item.status,
      item.expiresAt || "", item.customer ? item.customer.email : "",
    ].map(cell).join(","));

    return { csv: [header.join(","), ...rows].join("\r\n") };
  }


}
