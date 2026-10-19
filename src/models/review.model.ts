import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo, HasMany, Index } from "sequelize-typescript";
import { ProductVariant } from "./product-variant.model";
import { User } from "./user.model";
import { Shop } from "./shop.model";
import { OrderItem, OrderShipment } from "./order-shipment.model";
import { DeliveryPartner } from "./delivery.model";

export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

@Table({ tableName: "product_reviews", timestamps: true, paranoid: true, indexes: [{ name: "idx_reviews_variant_status", fields: ["variantId", "status"] }] })
export class ProductReview extends Model<ProductReview> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => User)
  @AllowNull(false)
  @Index
  @Column(DataType.UUID)
  declare userId: string;

  @BelongsTo(() => User, { constraints: false })
  declare user?: User;

  @ForeignKey(() => ProductVariant)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare variantId: string;

  @BelongsTo(() => ProductVariant)
  declare variant?: ProductVariant;

  /** Fulfilling shop, denormalised so shop managers can be scoped to their own reviews. */
  @ForeignKey(() => Shop)
  @Column(DataType.UUID)
  declare shopId: string | null;

  @BelongsTo(() => Shop, { constraints: false })
  declare shop?: Shop;

  /** The delivered purchase this review is about — proves the buy and blocks duplicates. */
  @ForeignKey(() => OrderItem)
  @Column(DataType.UUID)
  declare orderItemId: string | null;

  @AllowNull(false) @Column(DataType.INTEGER) declare rating: number;
  @Column(DataType.TEXT) declare text: string | null;
  @Default(false) @Column(DataType.BOOLEAN) declare verifiedPurchase: boolean;

  @Default("pending")
  @Index
  @Column(DataType.ENUM(...REVIEW_STATUSES))
  declare status: string;

  /** Moderator note kept for the audit trail (e.g. why a review was rejected). */
  @Column(DataType.STRING(500)) declare moderationNote: string | null;

  /** Seller / admin public response. */
  @Column(DataType.TEXT) declare reply: string | null;
  @ForeignKey(() => User) @Column(DataType.UUID) declare replyBy: string | null;
  @Column(DataType.DATE) declare repliedAt: Date | null;

  /** Denormalised vote tally — the source of truth is review_votes. */
  @Default(0) @Column(DataType.INTEGER) declare helpfulCount: number;

  @HasMany(() => ReviewMedia, { constraints: false })
  declare media?: ReviewMedia[];
}

@Table({ tableName: "review_media", timestamps: true })
export class ReviewMedia extends Model<ReviewMedia> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => ProductReview)
  @AllowNull(false)
  @Index
  @Column(DataType.UUID)
  declare reviewId: string;

  @BelongsTo(() => ProductReview, { constraints: false })
  declare review?: ProductReview;

  @AllowNull(false) @Column(DataType.STRING(500)) declare url: string;

  /** Mirrors ProductMedia.type so the UI can render photo vs video. */
  @Default("image") @Column(DataType.ENUM("image", "video")) declare type: string;
}

/** One row per (review, user) so "helpful" can't be stuffed. */
@Table({ tableName: "review_votes", timestamps: true })
export class ReviewVote extends Model<ReviewVote> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => ProductReview)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare reviewId: string;

  @ForeignKey(() => User)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare userId: string;
}

@Table({ tableName: "delivery_reviews", timestamps: true })
export class DeliveryReview extends Model<DeliveryReview> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @ForeignKey(() => OrderShipment)
  @AllowNull(false)
  @Column(DataType.UUID)
  declare shipmentId: string;

  @BelongsTo(() => OrderShipment, { constraints: false })
  declare shipment?: OrderShipment;

  /** Added so a delivery review has an owner: the endpoint used to be public and
   *  anonymous, so anyone could rate any shipment repeatedly. */
  @ForeignKey(() => User)
  @Column(DataType.UUID)
  declare userId: string | null;

  /** Lets a partner's rating actually be derived from their delivery reviews. */
  @ForeignKey(() => DeliveryPartner)
  @Column(DataType.UUID)
  declare partnerId: string | null;

  @AllowNull(false) @Column(DataType.INTEGER) declare rating: number;
  @Column(DataType.JSONB) declare tags: unknown;
  @Column(DataType.TEXT) declare feedback: string | null;
}
