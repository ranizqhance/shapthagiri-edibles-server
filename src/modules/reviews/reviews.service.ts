import { Injectable, Logger } from "@nestjs/common";
import { InjectModel, InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { Op, QueryTypes } from "sequelize";
import {
  ProductReview, ReviewMedia, ReviewVote, DeliveryReview, ProductVariant, Product,
  ProductMedia, Brand, OrderItem, OrderShipment, Order, User, AuditLog, DeliveryPartner, DeliveryAssignment,
} from "@/models";
import { REVIEW_STATUSES, ReviewStatus } from "@/models/review.model";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { Role } from "@/common/enums/role.enum";
import { OrderStatus } from "@/common/enums/order-status.enum";
import { BadRequestException, ForbiddenException, NotFoundException, ConflictException } from "@/common/errors/http";
import { shopScope } from "@/common/utils/permission.util";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate } from "@/common/utils/crud.util";
import { NotificationsService } from "@/modules/notifications/notifications.service";

export interface RatingSummary {
  average: number;
  count: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

const emptySummary = (): RatingSummary => ({
  average: 0,
  count: 0,
  distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keep only well-formed UUIDs.
 *
 * These ids arrive as a raw comma-separated query string, and the columns are
 * uuid — so a single junk value made Postgres throw "invalid input syntax for
 * type uuid" and the whole request 500'd. Unknown ids should just miss.
 */
const uuidsOnly = (ids: string[]) => [...new Set(ids.filter((id) => UUID_RE.test(id)))];

/**
 * Reviews.
 *
 * The controller used to write straight to the model with no purchase check, no
 * duplicate check and no scoping. All of that lives here now so every caller —
 * customer, shop manager, admin — goes through the same rules.
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @InjectModel(ProductReview) private readonly reviews: typeof ProductReview,
    @InjectModel(ReviewMedia) private readonly media: typeof ReviewMedia,
    @InjectModel(ReviewVote) private readonly votes: typeof ReviewVote,
    @InjectModel(DeliveryReview) private readonly deliveryReviews: typeof DeliveryReview,
    @InjectModel(OrderItem) private readonly orderItems: typeof OrderItem,
    @InjectModel(AuditLog) private readonly audit: typeof AuditLog,
    @InjectModel(Product) private readonly products: typeof Product,
    @InjectModel(ProductVariant) private readonly variants: typeof ProductVariant,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * A product's id from either form the storefront uses for it.
   *
   * Product pages live at /product/<slug> (UUID links redirect there), so the
   * page only has the slug in hand. The summary endpoint used to accept ids
   * only and dropped anything else as junk — every product page asked by slug
   * and got "no reviews" back, even with approved reviews on the product.
   */
  private async productIdFrom(idOrSlug: string): Promise<string | null> {
    if (UUID_RE.test(idOrSlug)) return idOrSlug;
    const slug = String(idOrSlug || "").trim().toLowerCase().slice(0, 200);
    if (!slug) return null;
    const p = await this.products.findOne({ where: { slug }, attributes: ["id"] });
    return p?.id ?? null;
  }

  /* ─────────────── helpers ─────────────── */

  /**
   * Finds a delivered line item for this user+variant. It is both the
   * verified-purchase proof and the anti-duplicate key.
   */
  private async findPurchase(userId: string, variantId: string): Promise<OrderItem | null> {
    return await this.orderItems.findOne({
      where: { variantId },
      include: [
        {
          model: OrderShipment,
          required: true,
          where: { status: { [Op.in]: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] } },
          include: [{ model: Order, required: true, where: { userId } }],
        },
      ],
      order: [["createdAt", "DESC"]],
    });
  }

  /** Shop managers may only touch reviews for their own shop. */
  private assertShopScope(user: JwtPayload, review: ProductReview) {
    if (user.role === Role.SHOP_MANAGER) {
      if (!user.shopId || review.shopId !== user.shopId) {
        throw new ForbiddenException("AUTH_FORBIDDEN", "This review belongs to another shop");
      }
    }
  }

  private publicInclude() {
    return [
      { model: ReviewMedia, required: false },
      { model: User, attributes: ["id", "name"], required: false },
    ];
  }

  /* ─────────────── customer ─────────────── */

  /**
   * Creates a review. Requires a delivered purchase of the variant and allows one
   * review per purchased line item.
   */
  async create(user: JwtPayload, variantId: string, body: { rating: number; text?: string; media?: string[] }) {
    const purchase = await this.findPurchase(user.sub, variantId);
    if (!purchase) {
      throw new ForbiddenException("AUTH_FORBIDDEN", "You can only review a product you have received.");
    }

    const existing = await this.reviews.findOne({ where: { userId: user.sub, orderItemId: purchase.id } });
    if (existing) {
      throw new ConflictException("CONFLICT", "You have already reviewed this purchase.");
    }

    const review = await this.reviews.create({
      userId: user.sub,
      variantId,
      shopId: purchase.shopId,
      orderItemId: purchase.id,
      rating: body.rating,
      text: body.text ?? null,
      // Earned from the delivered order — never accepted from the client.
      verifiedPurchase: true,
      status: "pending",
    } as any);

    await this.attachMedia(review.id, body.media);

    // Moderation queue signal — reviews are invisible until approved.
    await this.notifications.notifyRole(
      Role.ADMIN,
      "New review awaiting moderation",
      `A ${body.rating}★ review was submitted and needs approval.`,
    ).catch(() => undefined);

    return await this.reviews.findByPk(review.id, { include: this.publicInclude() });
  }

  private async attachMedia(reviewId: string, urls?: string[]) {
    if (!urls?.length) return;
    if (urls.length > 6) throw new BadRequestException("VALIDATION_FAILED", "At most 6 media items per review");
    const rows = urls.map((url) => ({
      reviewId,
      url,
      type: /\.(mp4|webm|mov)$/i.test(url) ? "video" : "image",
    }));
    await this.media.bulkCreate(rows as any);
  }

  /** Owner-only edit. Editing resets moderation — changed content must be re-approved. */
  async update(user: JwtPayload, id: string, body: { rating?: number; text?: string; media?: string[] }) {
    const review = await this.reviews.findByPk(id);
    if (!review) throw new NotFoundException("NOT_FOUND", "Review not found");
    if (review.userId !== user.sub) throw new ForbiddenException("AUTH_FORBIDDEN", "You can only edit your own review");

    await review.update({
      rating: body.rating ?? review.rating,
      text: body.text ?? review.text,
      status: "pending",
      moderationNote: null,
    });

    if (body.media) {
      await this.media.destroy({ where: { reviewId: id } });
      await this.attachMedia(id, body.media);
    }
    return await this.reviews.findByPk(id, { include: this.publicInclude() });
  }

  /** Owner (or staff) delete. Soft — the row is retained for audit. */
  async remove(user: JwtPayload, id: string) {
    const review = await this.reviews.findByPk(id);
    if (!review) throw new NotFoundException("NOT_FOUND", "Review not found");
    const isStaff = user.role === Role.ADMIN || user.role === Role.SHOP_MANAGER;
    if (!isStaff && review.userId !== user.sub) {
      throw new ForbiddenException("AUTH_FORBIDDEN", "You can only delete your own review");
    }
    if (user.role === Role.SHOP_MANAGER) this.assertShopScope(user, review);

    await review.destroy();
    return { deleted: true };
  }

  async listMine(user: JwtPayload, opts: PageOptionsDto) {
    return await paginate(this.reviews, opts, { userId: user.sub }, [
      { model: ReviewMedia, required: false },
      { model: ProductVariant, include: [{ model: Product, include: [ProductMedia, Brand] }] },
    ]);
  }

  /* ─────────────── public ─────────────── */

  /** Approved reviews only. Supports rating filter and helpful/recent sorting. */
  async listForVariant(variantId: string, opts: PageOptionsDto, filters: { rating?: number; sort?: string } = {}) {
    const where: any = { variantId, status: "approved" };
    if (filters.rating) where.rating = Number(filters.rating);

    const order: any =
      filters.sort === "helpful" ? [["helpfulCount", "DESC"]]
      : filters.sort === "rating_high" ? [["rating", "DESC"]]
      : filters.sort === "rating_low" ? [["rating", "ASC"]]
      : [["createdAt", "DESC"]];

    return await paginate(this.reviews, opts, where, this.publicInclude(), { order });
  }

  /**
   * Approved reviews for every variant of a product — what the product page
   * shows. Listing by the selected variant only meant a review written for the
   * 1 L pack was missing from the page while the 500 ml pack was selected,
   * although the star summary (product-wide) counted it. Each review carries
   * its variant's attributes so the page can say which pack it was for.
   */
  async listForProduct(idOrSlug: string, opts: PageOptionsDto, filters: { rating?: number; sort?: string } = {}) {
    const productId = await this.productIdFrom(idOrSlug);
    const variantIds = productId
      ? (await this.variants.findAll({ where: { productId }, attributes: ["id"], paranoid: false })).map((v) => v.id)
      : [];
    // An unknown product is an empty page, not an error.
    const where: any = { variantId: { [Op.in]: variantIds.length ? variantIds : [null] }, status: "approved" };
    if (filters.rating) where.rating = Number(filters.rating);

    const order: any =
      filters.sort === "helpful" ? [["helpfulCount", "DESC"]]
      : filters.sort === "rating_high" ? [["rating", "DESC"]]
      : filters.sort === "rating_low" ? [["rating", "ASC"]]
      : [["createdAt", "DESC"]];

    return await paginate(this.reviews, opts, where, [
      ...this.publicInclude(),
      { model: ProductVariant, attributes: ["id", "attributes"], required: false, paranoid: false },
    ], { order });
  }

  /**
   * Average + count + star distribution for a product's variants.
   * Approved reviews only, and — unlike the old `COALESCE(AVG(rating), 4.0)` —
   * an unreviewed product reports 0, not a fabricated 4 stars.
   * Accepts the product's id or its slug.
   */
  async summaryForProduct(idOrSlug: string): Promise<RatingSummary> {
    const productId = await this.productIdFrom(idOrSlug);
    if (!productId) return emptySummary();
    const map = await this.summaryForProducts([productId]);
    return map[productId] ?? emptySummary();
  }

  /**
   * Same aggregation as summaryForProduct, for many products in ONE query.
   *
   * The product grid needs a rating per card; calling summaryForProduct per card
   * would be an N+1 over HTTP. Products with no approved reviews are absent from
   * the result — callers treat a miss as "no reviews", not as 0 stars.
   */
  async summaryForProducts(productIds: string[]): Promise<Record<string, RatingSummary>> {
    const ids = uuidsOnly(productIds);
    if (!ids.length) return {};

    const rows = await this.sequelize.query<any>(
      `
      SELECT v."productId", r.rating, COUNT(*)::int AS n
      FROM product_reviews r
      JOIN product_variants v ON v.id = r."variantId"
      WHERE v."productId" IN (:ids)
        AND r.status = 'approved'
        AND r."deletedAt" IS NULL
      GROUP BY v."productId", r.rating
      `,
      { type: QueryTypes.SELECT, replacements: { ids } },
    );

    const totals: Record<string, { sum: number; count: number; dist: RatingSummary["distribution"] }> = {};
    for (const r of rows) {
      const pid = String(r.productId);
      const star = Number(r.rating);
      const n = Number(r.n);
      if (star < 1 || star > 5) continue;
      totals[pid] ??= { sum: 0, count: 0, dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
      totals[pid].dist[star as 1 | 2 | 3 | 4 | 5] = n;
      totals[pid].count += n;
      totals[pid].sum += star * n;
    }

    const out: Record<string, RatingSummary> = {};
    for (const [pid, t] of Object.entries(totals)) {
      out[pid] = {
        average: t.count ? Number((t.sum / t.count).toFixed(2)) : 0,
        count: t.count,
        distribution: t.dist,
      };
    }
    return out;
  }

  /**
   * Which of these reviews the caller has already marked helpful.
   *
   * GET /reviews/products/:variantId is @Public(), and @Public() short-circuits
   * the guard, so that response can never carry a viewer-specific flag. Without
   * this the Helpful button renders un-voted on every load and the next click
   * silently WITHDRAWS an existing vote while the UI counts it up.
   */
  async myVotes(user: JwtPayload, reviewIds: string[]): Promise<string[]> {
    const ids = uuidsOnly(reviewIds);
    if (!ids.length) return [];
    const votes = await this.votes.findAll({
      where: { userId: user.sub, reviewId: { [Op.in]: ids } },
      attributes: ["reviewId"],
    });
    return votes.map((v) => v.reviewId);
  }

  /** Helpful vote. One per user per review; voting again withdraws it. */
  async toggleHelpful(user: JwtPayload, id: string) {
    const review = await this.reviews.findByPk(id);
    if (!review) throw new NotFoundException("NOT_FOUND", "Review not found");
    if (review.userId === user.sub) {
      throw new BadRequestException("VALIDATION_FAILED", "You cannot mark your own review as helpful");
    }

    return await this.sequelize.transaction(async (t) => {
      const existing = await this.votes.findOne({ where: { reviewId: id, userId: user.sub }, transaction: t });
      const voted = !existing;

      if (existing) {
        await existing.destroy({ transaction: t });
        await review.decrement("helpfulCount", { by: 1, transaction: t });
      } else {
        await this.votes.create({ reviewId: id, userId: user.sub } as any, { transaction: t });
        await review.increment("helpfulCount", { by: 1, transaction: t });
      }

      // increment()/decrement() already mutate the in-memory instance, so deriving
      // the count by adding 1 again double-counted. Read the committed value back.
      await review.reload({ transaction: t });
      return { voted, helpfulCount: Math.max(Number(review.helpfulCount), 0) };
    });
  }

  /* ─────────────── staff ─────────────── */

  /**
   * Moderation queue. This is what was missing: the only list endpoint returned
   * approved reviews, so pending ones were unreachable and could never be approved.
   */
  async listForStaff(user: JwtPayload, opts: PageOptionsDto, filters: { rating?: number; sort?: string } = {}) {
    const where: any = {};
    if (opts.status) {
      if (!REVIEW_STATUSES.includes(opts.status as ReviewStatus)) {
        throw new BadRequestException("VALIDATION_FAILED", `status must be one of: ${REVIEW_STATUSES.join(", ")}`);
      }
      where.status = opts.status;
    }
    if (filters.rating) where.rating = Number(filters.rating);
    if (opts.q) where.text = { [Op.iLike]: `%${opts.q}%` };

    // Shop managers only ever see their own shop's reviews.
    if (user.role === Role.SHOP_MANAGER) {
      if (!user.shopId) throw new ForbiddenException("AUTH_FORBIDDEN", "Shop Manager must be assigned to a shop");
      where.shopId = user.shopId;
    }

    // Explicit, whitelisted sort. Passed via extraOpts so it overrides paginate's
    // generic sortBy handling (whose "rating" branch is Product-model specific).
    const order: any =
      filters.sort === "oldest" ? [["createdAt", "ASC"]]
      : filters.sort === "rating_high" ? [["rating", "DESC"], ["createdAt", "DESC"]]
      : filters.sort === "rating_low" ? [["rating", "ASC"], ["createdAt", "DESC"]]
      : filters.sort === "helpful" ? [["helpfulCount", "DESC"], ["createdAt", "DESC"]]
      : [["createdAt", "DESC"]]; // newest (default)

    return await paginate(this.reviews, opts, where, [
      { model: ReviewMedia, required: false },
      { model: User, attributes: ["id", "name", "email"], required: false },
      { model: ProductVariant, include: [{ model: Product, include: [ProductMedia] }] },
    ], { order });
  }

  /**
   * Shop-scoped review analytics for the manager dashboard: status counts, the
   * customer-visible average (approved only) and its star distribution. Same
   * scoping rule as listForStaff — a manager sees only their own shop.
   */
  async summaryForStaff(user: JwtPayload): Promise<{
    total: number; pending: number; approved: number; rejected: number;
    average: number; distribution: RatingSummary["distribution"];
  }> {
    let shopFilter = "";
    const replacements: any = {};
    if (user.role === Role.SHOP_MANAGER) {
      if (!user.shopId) throw new ForbiddenException("AUTH_FORBIDDEN", "Shop Manager must be assigned to a shop");
      shopFilter = `AND "shopId" = :shopId`;
      replacements.shopId = user.shopId;
    }

    const rows = await this.sequelize.query<any>(
      `SELECT status, rating, COUNT(*)::int AS n
         FROM product_reviews
        WHERE "deletedAt" IS NULL ${shopFilter}
        GROUP BY status, rating`,
      { type: QueryTypes.SELECT, replacements },
    );

    const byStatus = { pending: 0, approved: 0, rejected: 0 } as Record<string, number>;
    const distribution: RatingSummary["distribution"] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let approvedSum = 0;
    let approvedCount = 0;
    for (const r of rows) {
      const n = Number(r.n);
      if (r.status in byStatus) byStatus[r.status] += n;
      const star = Number(r.rating);
      if (r.status === "approved" && star >= 1 && star <= 5) {
        distribution[star as 1 | 2 | 3 | 4 | 5] += n;
        approvedSum += star * n;
        approvedCount += n;
      }
    }

    return {
      total: byStatus.pending + byStatus.approved + byStatus.rejected,
      pending: byStatus.pending,
      approved: byStatus.approved,
      rejected: byStatus.rejected,
      average: approvedCount ? Number((approvedSum / approvedCount).toFixed(2)) : 0,
      distribution,
    };
  }

  async moderate(user: JwtPayload, id: string, status: ReviewStatus, note?: string) {
    if (!REVIEW_STATUSES.includes(status)) {
      throw new BadRequestException("VALIDATION_FAILED", `status must be one of: ${REVIEW_STATUSES.join(", ")}`);
    }
    const review = await this.reviews.findByPk(id);
    if (!review) throw new NotFoundException("NOT_FOUND", "Review not found");
    this.assertShopScope(user, review);

    const before = review.status;
    await review.update({ status, moderationNote: note ?? null });

    await this.audit.create({
      actorId: user.sub, action: `review_${status}`, entity: "ProductReview", entityId: id,
      before: { status: before }, after: { status, note: note ?? null },
    } as any);

    if (before !== status) {
      await this.notifications.notify(
        review.userId,
        status === "approved" ? "Your review is live ⭐" : "Your review was not published",
        status === "approved"
          ? "Thanks for the feedback — your review is now visible on the product page."
          : `Your review wasn't published${note ? `: ${note}` : "."}`,
        "all",
        "/my-reviews",
      ).catch(() => undefined);
    }
    return { moderated: true, status };
  }

  /** Public seller/admin response to a review. */
  async reply(user: JwtPayload, id: string, text: string) {
    if (!text?.trim()) throw new BadRequestException("VALIDATION_FAILED", "Reply text is required");
    const review = await this.reviews.findByPk(id);
    if (!review) throw new NotFoundException("NOT_FOUND", "Review not found");
    this.assertShopScope(user, review);

    await review.update({ reply: text.trim(), replyBy: user.sub, repliedAt: new Date() });
    await this.notifications.notify(
      review.userId,
      "Someone replied to your review",
      text.trim().slice(0, 140),
      "all",
      "/my-reviews",
    ).catch(() => undefined);

    return await this.reviews.findByPk(id, { include: this.publicInclude() });
  }

  /* ─────────────── delivery reviews ─────────────── */

  /**
   * Rates a delivery. Now authenticated and owner-checked: the endpoint was
   * @Public and anonymous, so anyone could rate any shipment repeatedly.
   * Also links the partner so their rating can be derived.
   */
  async reviewDelivery(user: JwtPayload, shipmentId: string, body: { rating: number; tags?: string[]; feedback?: string }) {
    const shipment = await OrderShipment.findByPk(shipmentId, { include: [Order] });
    if (!shipment) throw new NotFoundException("NOT_FOUND", "Shipment not found");

    // Only the customer who received it — whatever the caller's role. This used
    // to test role === CUSTOMER, so any other account could rate (and thereby
    // move the rating of) any delivery partner's shipment.
    const ownerId = (shipment as any).order?.userId;
    if (ownerId !== user.sub) {
      throw new NotFoundException("NOT_FOUND", "Shipment not found");
    }
    if (![OrderStatus.DELIVERED, OrderStatus.COMPLETED].includes(shipment.status as any)) {
      throw new BadRequestException("VALIDATION_FAILED", "This shipment has not been delivered yet");
    }

    const existing = await this.deliveryReviews.findOne({ where: { shipmentId, userId: user.sub } });
    if (existing) throw new ConflictException("CONFLICT", "You have already reviewed this delivery");

    const assignment = await DeliveryAssignment.findOne({
      where: { shipmentId, status: { [Op.in]: ["delivered", "picked", "accepted"] } },
      order: [["createdAt", "DESC"]],
    });

    const review = await this.deliveryReviews.create({
      shipmentId, userId: user.sub, partnerId: assignment?.partnerId ?? null,
      rating: body.rating, tags: body.tags ?? null, feedback: body.feedback ?? null,
    } as any);

    if (assignment?.partnerId) await this.recomputePartnerRating(assignment.partnerId);
    return review;
  }

  /** Keeps DeliveryPartner.rating derived from real reviews instead of being static. */
  async recomputePartnerRating(partnerId: string) {
    const [row] = await this.sequelize.query<any>(
      `SELECT AVG(rating)::float8 AS avg, COUNT(*)::int AS n FROM delivery_reviews WHERE "partnerId" = :partnerId`,
      { type: QueryTypes.SELECT, replacements: { partnerId } },
    );
    if (!row?.n) return;
    await DeliveryPartner.update({ rating: Number(Number(row.avg).toFixed(2)) }, { where: { id: partnerId } });
  }

  async listDeliveryReviews(user: JwtPayload, opts: PageOptionsDto, filters: { partnerId?: string } = {}) {
    const where: any = {};
    if (filters.partnerId) where.partnerId = filters.partnerId;
    // A shop account sees reviews of its own shop's deliveries only.
    const shop = shopScope(user);
    if (shop) {
      where.shipmentId = { [Op.in]: this.sequelize.literal(`(SELECT id FROM order_shipments WHERE "shopId" = ${this.sequelize.escape(shop)})`) };
    }
    return await paginate(this.deliveryReviews, opts, where, []);
  }
}
