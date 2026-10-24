import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { SequelizeModule } from "@nestjs/sequelize";
import {
  DeliveryReview, ProductReview, ReviewMedia, ReviewVote, ProductVariant, Product, ProductMedia, Brand,
  OrderItem, OrderShipment, Order, User, AuditLog, DeliveryPartner, DeliveryAssignment,
} from "@/models";
import { Public } from "@/common/decorators/public.decorator";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { DeliveryReviewDto, ModerateDto, ProductReviewDto, ReviewReplyDto, UpdateReviewDto } from "@/common/dto/common.dto";
import { ReviewsService } from "./reviews.service";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import type { ReviewStatus } from "@/models/review.model";

@ApiTags("Reviews")
@Controller("reviews")
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /* ── Customer ── */

  /** Requires a delivered purchase; one review per purchased line item. */
  @ApiBearerAuth()
  @Post("products/:variantId")
  create(@CurrentUser() u: JwtPayload, @Param("variantId") variantId: string, @Body() b: ProductReviewDto) {
    return this.reviews.create(u, variantId, b);
  }

  @ApiBearerAuth()
  @Get("me")
  myReviews(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    return this.reviews.listMine(u, opts);
  }

  @ApiBearerAuth()
  @Post(":id/helpful")
  helpful(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    return this.reviews.toggleHelpful(u, id);
  }

  /**
   * Which of the given reviews the caller already voted helpful.
   * The storefront list is @Public() and so cannot carry a viewer flag itself.
   */
  @ApiBearerAuth()
  @Get("my-votes")
  myVotes(@CurrentUser() u: JwtPayload, @Query("reviewIds") reviewIds?: string) {
    return this.reviews.myVotes(u, (reviewIds || "").split(",").filter(Boolean));
  }

  /* ── Public storefront ── */

  @Public()
  @Get("products/:variantId")
  list(
    @Param("variantId") variantId: string,
    // NB: must be the bare DTO — an intersection type erases to `Object`, so
    // ValidationPipe skips it and `order`/`offset` go missing.
    @Query() opts: PageOptionsDto,
    @Query("rating") rating?: string,
    @Query("sort") sort?: string,
  ) {
    return this.reviews.listForVariant(variantId, opts, { rating: rating ? Number(rating) : undefined, sort });
  }

  /** Approved reviews across all of a product's variants. Takes the id or the slug. */
  @Public()
  @Get("product/:product")
  listForProduct(
    @Param("product") product: string,
    @Query() opts: PageOptionsDto,
    @Query("rating") rating?: string,
    @Query("sort") sort?: string,
  ) {
    return this.reviews.listForProduct(product, opts, { rating: rating ? Number(rating) : undefined, sort });
  }

  /**
   * Batch summaries for a product grid — one query, not one request per card.
   * Declared before "summary/:productId" so the literal wins the match.
   * Products with no approved reviews are simply absent from the map.
   */
  @Public()
  @Get("summary")
  summaryBatch(@Query("productIds") productIds?: string) {
    return this.reviews.summaryForProducts((productIds || "").split(",").filter(Boolean));
  }

  /** Average, count and star distribution — replaces the fabricated 4.0 default. Id or slug. */
  @Public()
  @Get("summary/:productId")
  summary(@Param("productId") productId: string) {
    return this.reviews.summaryForProduct(productId);
  }

  /* ── Staff ── */

  /**
   * Moderation queue (?status=pending). Without this, pending reviews were
   * unreachable — the only list endpoint returned approved reviews, so a
   * submitted review could never be found or approved.
   */
  @ApiBearerAuth()
  @RequirePermissions("reviews.view")
  @Get("admin")
  adminList(
    @CurrentUser() u: JwtPayload,
    @Query() opts: PageOptionsDto,
    @Query("rating") rating?: string,
    @Query("sort") sort?: string,
  ) {
    // `status` and `q` already live on PageOptionsDto.
    return this.reviews.listForStaff(u, opts, { rating: rating ? Number(rating) : undefined, sort });
  }

  /**
   * Shop-scoped review analytics (status counts, average, distribution) for the
   * manager dashboard. Literal path — declared alongside the queue, never shadowed
   * by a ":id" route.
   */
  @ApiBearerAuth()
  @RequirePermissions("reviews.view")
  @Get("admin/summary")
  adminSummary(@CurrentUser() u: JwtPayload) {
    return this.reviews.summaryForStaff(u);
  }

  @ApiBearerAuth()
  @RequirePermissions("reviews.moderate")
  @Post("admin/:id/moderate")
  moderate(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: ModerateDto) {
    return this.reviews.moderate(u, id, b.status as ReviewStatus, b.note);
  }

  @ApiBearerAuth()
  @RequirePermissions("reviews.reply")
  @Post(":id/reply")
  reply(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: ReviewReplyDto) {
    return this.reviews.reply(u, id, b.text);
  }

  /* ── Delivery ── */

  /** Authenticated + owner-checked (was @Public and anonymous). */
  @ApiBearerAuth()
  @Post("delivery/:shipmentId")
  delReview(@CurrentUser() u: JwtPayload, @Param("shipmentId") id: string, @Body() b: DeliveryReviewDto) {
    return this.reviews.reviewDelivery(u, id, b);
  }

  @ApiBearerAuth()
  @RequirePermissions("reviews.view")
  @Get("delivery")
  listDelivery(
    @CurrentUser() u: JwtPayload,
    @Query() opts: PageOptionsDto,
    @Query("partnerId") partnerId?: string,
  ) {
    return this.reviews.listDeliveryReviews(u, opts, { partnerId });
  }

  /* ── Owner CRUD (kept last: ':id' must not shadow the literal routes above) ── */

  @ApiBearerAuth()
  @Patch(":id")
  update(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: UpdateReviewDto) {
    return this.reviews.update(u, id, b);
  }

  @ApiBearerAuth()
  @Delete(":id")
  remove(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    return this.reviews.remove(u, id);
  }
}

@Module({
  imports: [
    SequelizeModule.forFeature([
      ProductReview, ReviewMedia, ReviewVote, DeliveryReview, ProductVariant, Product, ProductMedia, Brand,
      OrderItem, OrderShipment, Order, User, AuditLog, DeliveryPartner, DeliveryAssignment,
    ]),
    NotificationsModule,
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
