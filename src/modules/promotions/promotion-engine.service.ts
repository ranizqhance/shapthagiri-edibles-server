import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { BadRequestException } from "@/common/errors/http";
import { InjectModel } from "@nestjs/sequelize";
import { Op, Transaction } from "sequelize";
import { Promotion, ProductVariant, Setting, Coupon, PromotionRedemption } from "@/models";
import { PROMOTION_TIER } from "@/models/promotion-engine.model";
import { PromotionDto, UpdatePromotionDto } from "@/common/dto/common.dto";

/** A single automatic line/cart discount the resolver produced. */
export interface PromotionLineDiscount {
  variantId: string;
  shopId: string | null;
  promotionId: string;
  promotionType: string;
  amount: number;
}

/** A reward ("Get") line a Buy-X-Get-Y / Buy-X-Get-X promotion grants. Same shape the
 *  BOGO coupon path already uses, so Phase 3 can materialise it with the existing loop. */
export interface PromotionRewardLine {
  variantId: string;
  shopId: string | null;
  quantity: number;
  unitPriceBefore: number;
  unitPrice: number;
  discountPercent: number;
  parentVariantId: string;
  promotionId: string;
  productName?: string;
  productImage?: string;
  // Variant-aware labels (display only): the get item's variant + the buy item's identity.
  variantLabel?: string;
  buyProductName?: string;
  buyVariantLabel?: string;
}

export interface PromotionResolution {
  enabled: boolean;
  appliedPromotions: { id: string; name: string; type: string; tier: number; priority: number; stackable: boolean }[];
  lineDiscounts: PromotionLineDiscount[];
  rewardLines: PromotionRewardLine[];
  cartDiscount: number;
  totalLineDiscount: number;
  /** cartDiscount + totalLineDiscount + Σ reward savings — display value only. */
  totalBenefit: number;
  /** Promotions skipped because a usage/stock limit was reached (for clear messaging). */
  limited: { id: string; name: string; reason: string }[];
}

const EMPTY: PromotionResolution = {
  enabled: false, appliedPromotions: [], lineDiscounts: [], rewardLines: [],
  cartDiscount: 0, totalLineDiscount: 0, totalBenefit: 0, limited: [],
};

/**
 * Promotion Engine (plan Phase 1). Owns the `promotions` table (CRUD) and the
 * `resolve()` read path that evaluates AUTOMATIC promotions against a cart and returns
 * line discounts + reward lines. Phase 1 is read/preview ONLY — the checkout/order flow
 * does NOT consume this yet, and the whole engine is gated behind the
 * `promotion.engine.enabled` setting (default false) so it is inert until deliberately
 * switched on.
 */
@Injectable()
export class PromotionEngineService {
  private readonly logger = new Logger(PromotionEngineService.name);
  constructor(
    @InjectModel(Promotion) private promotion: typeof Promotion,
    @InjectModel(Setting) private setting: typeof Setting,
    @InjectModel(Coupon) private coupon: typeof Coupon,
    @InjectModel(PromotionRedemption) private redemption: typeof PromotionRedemption,
  ) {}

  /* ── Phase 4: mirror legacy `bogo` coupons into the Promotion Engine ──────────
   * Backward-compatible: mirrored promotions are created as DRAFT + inactive, so
   * nothing auto-applies. The source coupons keep working via the coupon-code path
   * throughout. Idempotent (keyed on `sourceCouponId`), dry-run by default. */
  async migrateBogoCoupons(apply = false, actorId?: string) {
    const bogoCoupons = await this.coupon.findAll({ where: { type: "bogo" } });
    const results: { coupon: string; action: string; promotionId?: string }[] = [];

    for (const cp of bogoCoupons) {
      const rule = (cp.rules as any)?.bogo;
      const existing = await this.promotion.findOne({ where: { sourceCouponId: cp.id } });
      if (existing) { results.push({ coupon: cp.code, action: "skip-already-mirrored", promotionId: existing.id }); continue; }
      if (!rule || !rule.buyVariantId || !rule.getVariantId) { results.push({ coupon: cp.code, action: "skip-incomplete-rule" }); continue; }
      if (!apply) { results.push({ coupon: cp.code, action: "would-create" }); continue; }

      const promo = await this.promotion.create({
        name: `BOGO (migrated from ${cp.code})`,
        type: "buy_x_get_y",
        tier: PROMOTION_TIER["buy_x_get_y"],
        scope: "all",
        discountKind: "reward",
        rewardRule: rule,
        shopId: rule.shopId ?? null,
        priority: cp.priority ?? 0,
        stackable: cp.stackable ?? false,
        startsAt: cp.startsAt ?? null,
        endsAt: cp.expiresAt ?? null,
        // DRAFT + inactive: do NOT auto-apply. Admin reviews, then activates the
        // promotion AND deactivates the coupon — behaviour stays identical meanwhile.
        status: "draft",
        isActive: false,
        sourceCouponId: cp.id,
        createdBy: actorId ?? null,
      } as any);
      results.push({ coupon: cp.code, action: "created-draft", promotionId: promo.id });
    }

    return { apply, scanned: bogoCoupons.length, results };
  }

  /* ── Feature flag (Phase 6: now DEFAULT-ON) ──────────────────────────────────
   * The Promotion Engine is the permanent production path. The setting is retained only
   * as an emergency KILL-SWITCH: it is enabled unless the value is explicitly set to
   * false. Absent setting → enabled. */
  async isEnabled(): Promise<boolean> {
    const row = await this.setting.findOne({ where: { key: "promotion.engine.enabled" } });
    if (!row) return true; // default ON
    const v = row.value as unknown;
    return !(v === false || v === "false" || v === 0 || v === "0");
  }

  /** Toggle the Promotion Engine on/off (admin). Governs whether the resolver/orchestrator
   *  have any effect at checkout/order — off leaves the coupon-only path in full control. */
  async setEnabled(enabled: boolean) {
    const [row] = await this.setting.findOrCreate({
      where: { key: "promotion.engine.enabled" },
      defaults: { key: "promotion.engine.enabled", value: enabled as any, scope: "system" } as any,
    });
    await row.update({ value: enabled as any });
    return { enabled };
  }

  /* ── CRUD (minimal — full admin UI is Phase 5) ──────────────────────────── */
  private applyTier(data: any) {
    if (data?.type && PROMOTION_TIER[data.type] != null) data.tier = PROMOTION_TIER[data.type];
  }

  private isRewardType(type?: string) {
    return type === "buy_x_get_y" || type === "buy_x_get_x";
  }

  /**
   * Validate a reward (Buy-X-Get-Y / Buy-X-Get-X) configuration before persisting, so an
   * invalid promotion can never be saved and then silently no-op at checkout. Checks: rule
   * present + complete (qty ≥ 1, discount 1–100), buy/get variants exist, a shop is set,
   * and the get variant is stocked at that shop (so the reward can actually be fulfilled).
   */
  private async validateRewardRule(type: string, rule: any, shopId?: string | null) {
    if (!rule) throw new BadRequestException("VALIDATION_FAILED", "A Buy-X-Get-Y promotion requires a reward rule.");
    const buyId = rule.buyVariantId;
    const getId = type === "buy_x_get_x" ? (rule.getVariantId || rule.buyVariantId) : rule.getVariantId;
    if (!buyId) throw new BadRequestException("VALIDATION_FAILED", "Reward rule: a buy variant is required.");
    if (!getId) throw new BadRequestException("VALIDATION_FAILED", "Reward rule: a get variant is required.");

    const buyQty = Number(rule.buyQty), getQty = Number(rule.getQty), pct = Number(rule.discountPercent);
    if (!(buyQty >= 1)) throw new BadRequestException("VALIDATION_FAILED", "Reward rule: buy quantity must be at least 1.");
    if (!(getQty >= 1)) throw new BadRequestException("VALIDATION_FAILED", "Reward rule: get quantity must be at least 1.");
    if (!(pct >= 1 && pct <= 100)) throw new BadRequestException("VALIDATION_FAILED", "Reward rule: discount % must be between 1 and 100.");

    const promoShop = shopId || rule.shopId;
    if (!promoShop) throw new BadRequestException("VALIDATION_FAILED", "Reward rule: a shop must be assigned.");

    const buy = await ProductVariant.findByPk(buyId, { include: [{ association: "inventory" }] });
    if (!buy) throw new BadRequestException("VALIDATION_FAILED", "Reward rule: the buy variant does not exist.");
    const get = await ProductVariant.findByPk(getId, { include: [{ association: "inventory" }] });
    if (!get) throw new BadRequestException("VALIDATION_FAILED", "Reward rule: the get variant does not exist.");
    const stockedHere = (get.inventory || []).some((inv: any) => inv.shopId === promoShop);
    if (!stockedHere) throw new BadRequestException("VALIDATION_FAILED", "Reward rule: the get variant is not stocked at the selected shop.");
  }

  async create(dto: PromotionDto, actorId: string) {
    const data: any = { ...dto, createdBy: actorId };
    this.applyTier(data);
    if (this.isRewardType(data.type)) {
      await this.validateRewardRule(data.type, data.rewardRule, data.shopId);
    }
    if (data.status === "active") data.isActive = true;
    return this.promotion.create(data);
  }

  async update(id: string, dto: UpdatePromotionDto, _actorId: string) {
    const p = await this.promotion.findByPk(id);
    if (!p) throw new NotFoundException("NOT_FOUND", "Promotion not found");
    const data: any = { ...dto };
    this.applyTier(data);
    // Validate when the (possibly edited) promotion is a reward type — using the new
    // rule/shop if supplied, else the existing ones.
    const effType = data.type ?? p.type;
    if (this.isRewardType(effType)) {
      await this.validateRewardRule(effType, data.rewardRule ?? p.rewardRule, data.shopId ?? p.shopId);
    }
    if (data.status === "active") data.isActive = true;
    if (data.status && ["draft", "paused", "inactive", "expired"].includes(data.status)) data.isActive = false;
    await p.update(data);
    return p;
  }

  async remove(id: string) {
    const p = await this.promotion.findByPk(id);
    if (!p) throw new NotFoundException("NOT_FOUND", "Promotion not found");
    await p.destroy();
    return { deleted: true };
  }

  async list(opts: { type?: string; status?: string } = {}) {
    const where: any = {};
    if (opts.type) where.type = opts.type;
    if (opts.status) where.status = opts.status;
    const rows = await this.promotion.findAll({ where, order: [["tier", "ASC"], ["priority", "DESC"], ["createdAt", "DESC"]] });
    return { items: rows };
  }

  /* ── Discovery (badges) ─────────────────────────────────────────────────────
   * Storefront promotion discovery. Given a batch of variants, returns the active
   * promotions applicable to each — reusing the SAME shop + scope matching the resolver
   * uses (no business logic is duplicated in the frontend). Read-only; respects the
   * engine flag. Reward promos badge on their BUY variant and carry the get product name
   * + buy/get quantities so the UI can show progress without any pricing calculation. */
  async applicableBadges(items: { variantId: string; shopId?: string }[]): Promise<Record<string, any[]>> {
    if (!(await this.isEnabled()) || !items?.length) return {};
    const variantIds = Array.from(new Set(items.map((i) => i.variantId).filter(Boolean)));
    if (!variantIds.length) return {};

    // `required: true` on a published product: this endpoint is public and took
    // arbitrary variant ids, so an unpublished product's name came back to
    // anyone who asked. Badges for a product nobody can buy are noise anyway.
    const variants = await ProductVariant.findAll({
      where: { id: variantIds },
      include: [
        { association: "product", where: { status: "published" }, required: true },
        { association: "inventory" },
      ],
    });
    const vmap = new Map(variants.map((v: any) => [v.id, v]));
    const promos = await this.activePromotions();

    // Resolve get-variant product names for reward badges (may not be in the batch).
    const getIds = Array.from(new Set(
      promos.filter((p) => p.type === "buy_x_get_y" || p.type === "buy_x_get_x")
        .map((p) => (p.rewardRule as any)?.getVariantId || (p.rewardRule as any)?.buyVariantId)
        .filter(Boolean),
    ));
    const getVars = getIds.length
      ? await ProductVariant.findAll({ where: { id: getIds }, include: [{ association: "product" }] })
      : [];
    const getVarMap = new Map(getVars.map((v: any) => [v.id, v]));

    const out: Record<string, any[]> = {};
    for (const it of items) {
      const info = vmap.get(it.variantId);
      const line = { variantId: it.variantId, shopId: it.shopId || null };
      const badges: any[] = [];
      for (const p of promos) {
        if (!this.lineMatchesShop(line, p)) continue;
        if (p.type === "buy_x_get_y" || p.type === "buy_x_get_x") {
          const rule: any = p.rewardRule || {};
          // Badge lives on the BUY product.
          if (rule.buyVariantId !== it.variantId) continue;
          const getId = p.type === "buy_x_get_x" ? rule.buyVariantId : rule.getVariantId;
          const getVar: any = getVarMap.get(getId);
          badges.push({
            promotionId: p.id, type: p.type, name: p.name, priority: p.priority,
            buyQty: Number(rule.buyQty || 1), getQty: Number(rule.getQty || 1),
            discountPercent: Number(rule.discountPercent ?? 100),
            getVariantId: getId, getProductName: getVar?.product?.title || null,
            // Variant-aware labels (display only).
            buyProductName: info?.product?.title || null,
            buyVariantLabel: this.variantLabel(info?.attributes),
            getVariantLabel: this.variantLabel(getVar?.attributes),
          });
        } else {
          if (!this.lineMatchesScope(line, p, info)) continue;
          badges.push({
            promotionId: p.id, type: p.type, name: p.name, priority: p.priority,
            discountKind: p.discountKind, discountValue: p.discountValue != null ? Number(p.discountValue) : null,
            minSubtotal: (p.metadata as any)?.minSubtotal != null ? Number((p.metadata as any).minSubtotal) : null,
          });
        }
      }
      if (badges.length) out[it.variantId] = badges.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }
    return out;
  }

  /**
   * Product-level offer flags for listing cards. For each product returns whether ANY of
   * its variants has an active promotion (so the card shows a GENERIC "Offer Available"
   * badge, never variant-specific text). Reuses `applicableBadges` — no new matching logic.
   */
  async productOffers(productIds: string[], shopId?: string): Promise<Record<string, { hasOffer: boolean; types: string[] }>> {
    if (!(await this.isEnabled()) || !productIds?.length) return {};
    const variants = await ProductVariant.findAll({
      where: { productId: productIds },
      attributes: ["id", "productId"],
    });
    if (!variants.length) return {};
    const badgeMap = await this.applicableBadges(variants.map((v: any) => ({ variantId: v.id, shopId })));

    const agg: Record<string, Set<string>> = {};
    for (const v of variants as any[]) {
      const b = badgeMap[v.id];
      if (b?.length) {
        (agg[v.productId] ||= new Set<string>());
        b.forEach((x: any) => agg[v.productId].add(x.type));
      }
    }
    const out: Record<string, { hasOffer: boolean; types: string[] }> = {};
    for (const [pid, types] of Object.entries(agg)) out[pid] = { hasOffer: true, types: Array.from(types) };
    return out;
  }

  /* ── Resolver (read path) ───────────────────────────────────────────────── */

  /** Active = flagged active, status 'active', and now within [startsAt, endsAt] (null = open). */
  private async activePromotions(): Promise<Promotion[]> {
    const now = new Date();
    return this.promotion.findAll({
      where: {
        isActive: true,
        status: "active",
        [Op.and]: [
          { [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: now } }] },
          { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gte]: now } }] },
        ],
      },
      order: [["tier", "ASC"], ["priority", "DESC"], ["startsAt", "DESC"]],
    });
  }

  private idList(v: unknown): string[] {
    return Array.isArray(v) ? (v as string[]) : [];
  }

  /** Human variant label from a variant's attributes, e.g. {Weight:"500g"} → "500g". */
  private variantLabel(attrs: any): string {
    if (!attrs || typeof attrs !== "object") return "";
    return Object.values(attrs).filter(Boolean).join(" · ");
  }

  /** Shop-scope gate (§3.3): exclusion always wins; then single/multiple/all inclusion. */
  private lineMatchesShop(line: any, p: Promotion): boolean {
    const excluded = this.idList(p.excludeShopIds);
    if (line.shopId && excluded.includes(line.shopId)) return false;
    if (p.shopId) return line.shopId === p.shopId;
    const many = this.idList(p.shopIds);
    if (many.length) return !!line.shopId && many.includes(line.shopId);
    return true; // all-shops
  }

  /** Product-scope gate. `info` = the line's variant (with product) from the map. */
  private lineMatchesScope(line: any, p: Promotion, info: any): boolean {
    const ids = this.idList(p.scopeIds);
    switch (p.scope) {
      case "all":
      case "cart":
        return true;
      case "category":
        return !!info?.product && ids.includes(info.product.categoryId);
      case "brand":
        return !!info?.product && ids.includes(info.product.brandId);
      case "variant":
      case "product":
        return ids.includes(line.variantId) || (!!info && ids.includes(info.productId));
      case "shop":
        return !!line.shopId && ids.includes(line.shopId);
      default:
        return false;
    }
  }

  private lineDiscountAmount(kind: string | null, value: number | null, lineSubtotal: number): number {
    const val = Number(value || 0);
    if (kind === "pct") return Math.round((lineSubtotal * val) / 100);
    if (kind === "flat") return Math.min(val, lineSubtotal); // flat off this line
    return 0;
  }

  /**
   * Evaluate all active automatic promotions against a cart. Returns line discounts +
   * reward lines. Line-price cuts (flash/festival/category) do NOT compound on the same
   * line — the best-ranked eligible one wins unless `stackable` (§3.1/§3.2). Reward and
   * cart-level promotions are additive. Never throws — returns EMPTY when disabled.
   */
  async resolve(cartItems: any[], ctx: { userId?: string; shopId?: string; transaction?: Transaction } = {}): Promise<PromotionResolution> {
    if (!(await this.isEnabled())) return { ...EMPTY };
    if (!cartItems?.length) return { ...EMPTY, enabled: true };

    // Build a variant→info map (product for category/brand, inventory for reward pricing).
    const variantIds = Array.from(new Set(cartItems.map((i) => i.variantId).filter(Boolean)));
    const variants = variantIds.length
      ? await ProductVariant.findAll({ where: { id: variantIds }, include: [{ association: "product" }, { association: "inventory" }] })
      : [];
    const vmap = new Map(variants.map((v: any) => [v.id, v]));

    /*
     * The unit price comes from the database, not from the caller.
     *
     * `POST /promotions/resolve` and `/orchestrate/preview` take
     * `items: any[]` straight from the request body, and this line used to
     * read `priceSnapshot` off it first. Every percentage discount, every
     * minimum-order threshold and every reward decision below is computed
     * from this number, so a caller could name their own price and change
     * what the engine granted. The client value is now only a fallback for a
     * variant that no longer exists, where there is nothing better to use.
     */
    const serverUnitPrice = (variantId: string): number | null => {
      const v: any = vmap.get(variantId);
      if (!v) return null;
      const sellable = (v.inventory ?? []).filter((inv: any) => inv.isActive);
      const prices = sellable
        .map((inv: any) => Number(inv.priceOverride ?? v.defaultPrice ?? 0))
        .filter((n: number) => n > 0);
      if (prices.length) return Math.min(...prices);
      const fallback = Number(v.defaultPrice ?? 0);
      return fallback > 0 ? fallback : null;
    };

    // Normalise lines: stamp the serving shop when the caller supplied one (buy-now/pinned).
    const lines = cartItems.map((i) => ({
      variantId: i.variantId,
      quantity: Number(i.quantity || 0),
      shopId: i.shopId || ctx.shopId || null,
      unitPrice: serverUnitPrice(i.variantId) ?? Number(i.priceSnapshot ?? i.price ?? 0),
    }));

    const promos = await this.activePromotions();

    const lineDiscounts: PromotionLineDiscount[] = [];
    const rewardLines: PromotionRewardLine[] = [];
    const applied: PromotionResolution["appliedPromotions"] = [];
    const lineCutConsumed = new Set<string>(); // variantId|shopId already carrying a line-price cut
    const limited: PromotionResolution["limited"] = [];
    let cartDiscount = 0;
    let rewardSavings = 0;

    const preDiscountSubtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

    for (const p of promos) {
      // HP1: enforce usage/per-user/stock limits from the redemption ledger. Over-limit
      // promotions are skipped so they simply don't apply (the order/checkout is never
      // blocked). During order placement (ctx.transaction present) the promotion row is
      // locked FOR UPDATE first, serialising concurrent orders → no over-redemption.
      const lim = await this.checkLimit(p, ctx);
      if (!lim.ok) { limited.push({ id: p.id, name: p.name, reason: lim.reason! }); continue; }

      if (p.type === "buy_x_get_y" || p.type === "buy_x_get_x") {
        const reward = await this.buildReward(p, lines, vmap, ctx);
        if (reward) {
          rewardLines.push(reward);
          rewardSavings += Math.round(reward.quantity * reward.unitPriceBefore * reward.discountPercent) / 100;
          applied.push({ id: p.id, name: p.name, type: p.type, tier: p.tier, priority: p.priority, stackable: p.stackable });
        }
        continue;
      }

      if (p.type === "cart") {
        // Threshold on the pre-discount subtotal (min in metadata.minSubtotal).
        const min = Number((p.metadata as any)?.minSubtotal || 0);
        if (preDiscountSubtotal >= min) {
          const amt = this.lineDiscountAmount(p.discountKind, p.discountValue, preDiscountSubtotal);
          if (amt > 0) {
            cartDiscount += amt;
            applied.push({ id: p.id, name: p.name, type: p.type, tier: p.tier, priority: p.priority, stackable: p.stackable });
          }
        }
        continue;
      }

      // Line-price cuts: flash / festival / category / auto(line-scoped).
      let promoApplied = false;
      for (const line of lines) {
        const key = `${line.variantId}|${line.shopId}`;
        if (lineCutConsumed.has(key) && !p.stackable) continue;
        const info = vmap.get(line.variantId);
        if (!this.lineMatchesShop(line, p) || !this.lineMatchesScope(line, p, info)) continue;

        const lineSubtotal = line.unitPrice * line.quantity;
        const amount = this.lineDiscountAmount(p.discountKind, p.discountValue, lineSubtotal);
        if (amount <= 0) continue;

        lineDiscounts.push({ variantId: line.variantId, shopId: line.shopId, promotionId: p.id, promotionType: p.type, amount });
        if (!p.stackable) lineCutConsumed.add(key);
        promoApplied = true;
      }
      if (promoApplied) applied.push({ id: p.id, name: p.name, type: p.type, tier: p.tier, priority: p.priority, stackable: p.stackable });
    }

    const totalLineDiscount = lineDiscounts.reduce((s, d) => s + d.amount, 0);
    return {
      enabled: true,
      appliedPromotions: applied,
      lineDiscounts,
      rewardLines,
      cartDiscount,
      totalLineDiscount,
      totalBenefit: Math.round((totalLineDiscount + cartDiscount + rewardSavings) * 100) / 100,
      limited,
    };
  }

  /**
   * Enforce a promotion's usage / per-user / stock-cap limits against the redemption
   * ledger. Returns `{ ok:false, reason }` when a limit is reached (the caller skips it).
   * When a transaction is supplied (order placement) the promotion row is locked FOR
   * UPDATE first, so concurrent orders serialise and the ledger count is race-safe.
   */
  private async checkLimit(p: Promotion, ctx: { userId?: string; transaction?: Transaction }): Promise<{ ok: boolean; reason?: string }> {
    const { usageLimit, perUserLimit, stockCap } = p;
    if (usageLimit == null && perUserLimit == null && stockCap == null) return { ok: true };
    const t = ctx.transaction;
    if (t) await this.promotion.findByPk(p.id, { lock: t.LOCK.UPDATE, transaction: t });

    if (usageLimit != null) {
      const uses = await this.redemption.count({ where: { promotionId: p.id }, transaction: t });
      if (uses >= usageLimit) return { ok: false, reason: "usage limit reached" };
    }
    if (perUserLimit != null && ctx.userId) {
      const byUser = await this.redemption.count({ where: { promotionId: p.id, userId: ctx.userId }, transaction: t });
      if (byUser >= perUserLimit) return { ok: false, reason: "per-customer limit reached" };
    }
    if (stockCap != null) {
      const units = Number((await this.redemption.sum("rewardQuantity", { where: { promotionId: p.id }, transaction: t })) || 0);
      if (units >= stockCap) return { ok: false, reason: "sold out" };
    }
    return { ok: true };
  }

  /** Compute a reward line for a Buy-X-Get-Y / Buy-X-Get-X promotion. Mirrors the BOGO
   *  coupon math: freeQty scales with how many buy-bundles are in the cart. */
  private async buildReward(p: Promotion, lines: any[], vmap: Map<string, any>, ctx: { shopId?: string }): Promise<PromotionRewardLine | null> {
    const rule: any = p.rewardRule || {};
    const buyVariantId = rule.buyVariantId;
    const getVariantId = p.type === "buy_x_get_x" ? buyVariantId : rule.getVariantId;
    if (!buyVariantId || !getVariantId) return null;
    const buyQty = Math.max(1, Number(rule.buyQty || 1));
    const getQty = Math.max(1, Number(rule.getQty || 1));
    const pct = Math.min(100, Math.max(1, Number(rule.discountPercent || 100)));
    const promoShop = p.shopId || rule.shopId || null;

    const buyLine = lines.find((l) => l.variantId === buyVariantId && this.lineMatchesShop(l, p) && (!promoShop || !l.shopId || l.shopId === promoShop));
    if (!buyLine || buyLine.quantity < buyQty) return null;

    const freeQty = Math.floor(buyLine.quantity / buyQty) * getQty;
    if (freeQty <= 0) return null;

    // Get-variant price + image at the promo shop (may not be in the cart). Load media so
    // the reward line shows the real product image (display only).
    let getVar: any = vmap.get(getVariantId);
    if (!getVar || !getVar.product?.media) {
      getVar = await ProductVariant.findByPk(getVariantId, {
        include: [{ association: "product", include: [{ association: "media" }] }, { association: "inventory" }],
      });
    }
    if (!getVar) return null;
    const shopId = promoShop || buyLine.shopId || ctx.shopId || null;
    const invRow = (getVar.inventory || []).find((x: any) => !shopId || x.shopId === shopId);
    const unitBefore = Number(invRow?.priceOverride ?? getVar.defaultPrice ?? 0);
    const unitAfter = Math.round(unitBefore * (100 - pct)) / 100;

    return {
      variantId: getVariantId,
      shopId,
      quantity: freeQty,
      unitPriceBefore: unitBefore,
      unitPrice: unitAfter,
      discountPercent: pct,
      parentVariantId: buyVariantId,
      promotionId: p.id,
      productName: getVar.product?.title,
      // Display image for the reward line — real product media, then legacy fields.
      productImage: getVar.product?.media?.[0]?.url || getVar.product?.imageUrl || (Array.isArray(getVar.product?.images) ? getVar.product.images[0] : undefined),
      // Variant-aware labels (display only).
      variantLabel: this.variantLabel(getVar.attributes),
      buyProductName: vmap.get(buyVariantId)?.product?.title,
      buyVariantLabel: this.variantLabel(vmap.get(buyVariantId)?.attributes),
    };
  }
}
