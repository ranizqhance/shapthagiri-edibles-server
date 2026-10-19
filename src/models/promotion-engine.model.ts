import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Index } from "sequelize-typescript";

/**
 * Promotion Engine record (Promotion Engine plan, Phase 1). An AUTOMATIC promotion —
 * applied by the resolver without a code, distinct from Coupons (code-driven) and the
 * legacy `deals` table (display-only "Deals of the Day"). Generalises `deals`: a single
 * table backs Flash Sales, Festival Offers, Category promos, Cart-threshold promos,
 * blanket Automatic promos, and Buy-X-Get-Y / Buy-X-Get-X rewards.
 *
 * `tier` is derived from `type` (see PROMOTION_TIER) and stored so the resolver can fetch
 * in priority order — lower tier wins per the Priority Matrix (§3.1). Nothing in the
 * checkout/order path reads this table yet; Phase 1 wires only the read/preview path.
 */
@Table({ tableName: "promotions", timestamps: true, paranoid: true })
export class Promotion extends Model<Promotion> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @AllowNull(false) @Column(DataType.STRING(160)) declare name: string;

  // Nature of the promotion. Drives which config (discount vs rewardRule) applies and
  // the resolver branch used.
  @AllowNull(false)
  @Column(DataType.ENUM("auto", "buy_x_get_y", "buy_x_get_x", "cart", "category", "festival", "flash"))
  declare type: string;

  // Derived from `type` at write time (PROMOTION_TIER). Stored for the ordered resolver scan.
  @Default(6) @Index @Column(DataType.INTEGER) declare tier: number;

  // What the promotion targets. `all` = store-wide. scopeIds holds the concrete ids
  // (category ids, variant ids, brand ids…) for the scope.
  @Default("all")
  @Column(DataType.ENUM("cart", "product", "variant", "category", "brand", "shop", "all"))
  declare scope: string;
  @Column(DataType.JSONB) declare scopeIds: unknown | null;

  // Line/cart discount. `reward` types carry their config in `rewardRule` instead.
  @Column(DataType.ENUM("pct", "flat", "reward")) declare discountKind: string | null;
  @Column(DataType.DECIMAL(10, 2)) declare discountValue: number | null;

  // Buy-X-Get-Y / Buy-X-Get-X config: { buyVariantId, getVariantId, buyQty, getQty, discountPercent }.
  // Supersedes the coupon `rules.bogo` blob for promotion-native rewards.
  @Column(DataType.JSONB) declare rewardRule: unknown | null;

  @Default(0) @Column(DataType.INTEGER) declare priority: number;
  @Default(false) @Column(DataType.BOOLEAN) declare stackable: boolean;

  @Column(DataType.DATE) declare startsAt: Date | null;
  @Column(DataType.DATE) declare endsAt: Date | null;

  @Column(DataType.INTEGER) declare usageLimit: number | null;
  @Column(DataType.INTEGER) declare perUserLimit: number | null;
  // Flash sales: cap the number of discounted units independent of physical stock.
  @Column(DataType.INTEGER) declare stockCap: number | null;

  // Multi-shop scope (§3.3). `excludeShopIds` always wins over inclusion.
  @Column(DataType.UUID) declare shopId: string | null;
  @Column(DataType.JSONB) declare shopIds: unknown | null;
  @Column(DataType.JSONB) declare excludeShopIds: unknown | null;

  @Default(true) @Index @Column(DataType.BOOLEAN) declare isActive: boolean;
  @Default("draft")
  @Column(DataType.ENUM("draft", "active", "paused", "inactive", "expired"))
  declare status: string;

  @Column(DataType.JSONB) declare metadata: unknown | null; // banner/label etc.
  @Column(DataType.UUID) declare createdBy: string | null;

  // Provenance for Phase 4: set when this promotion was mirrored from a legacy `bogo`
  // coupon (idempotency key for the backfill; links the two during migration).
  @Column(DataType.UUID) declare sourceCouponId: string | null;
}

/** type → priority tier (Priority Matrix §3.1). Lower = evaluated first / wins ties. */
export const PROMOTION_TIER: Record<string, number> = {
  flash: 1,
  festival: 2,
  category: 3,
  buy_x_get_y: 4,
  buy_x_get_x: 4,
  cart: 5,
  auto: 6,
};
