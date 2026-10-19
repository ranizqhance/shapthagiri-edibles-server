import crypto from "node:crypto";
import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Setting } from "@/models";
import { ShippingRateService } from "@/modules/delivery-engine/shipping-rate.service";

/**
 * Inputs for the delivery charge.
 *
 * Delivery used to be priced on distance to the farthest shop. It is now priced
 * the way the courier actually bills: parcel weight against a destination zone.
 * Distance still decides which shop serves an order and whether an address is
 * reachable at all — it just no longer decides the price.
 */
export interface DeliveryContext {
  /**
   * Chargeable parcel weight in GRAMS — products plus wrapping plus the outer
   * box, already rounded. Undefined (e.g. cart preview, which has no address
   * and so no zone) → fee deferred, ₹0.
   */
  parcelG?: number;
  /** Delivery address state, resolved to a shipping zone. Unmatched → default zone. */
  state?: string | null;
  /** Pickup / self-collect → always ₹0 delivery. */
  isPickup?: boolean;
}

export interface PriceBreakdown {
  taxableBase: number;
  tax: number;
  taxRate: number;
  deliveryFee: number;
  total: number;
  loyaltyDiscount: number;
  giftCardDiscount: number;
  payableAmount: number;
}

/**
 * Centralises order pricing so tax rate and delivery fees are configurable via
 * the `settings` table (admin → /settings) rather than hardcoded. Falls back to
 * sensible defaults when a setting is absent.
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);
  constructor(
    @InjectModel(Setting) private setting: typeof Setting,
    private readonly shippingRates: ShippingRateService,
  ) {}

  /**
   * Settings cache.
   *
   * Every pricing call read four or five settings rows straight from the
   * database, and pricing runs on every delivery estimate, every checkout
   * preview and every order placement — so a single checkout session issued
   * dozens of identical one-row queries. These values change when an admin
   * edits them, which is rare enough that thirty seconds of staleness is
   * invisible and the saving is not.
   *
   * Mirrors the approach already used by ZoneCacheService.
   */
  private static readonly SETTINGS_TTL_MS = 30_000;
  private static settingsCache: { at: number; byKey: Map<string, unknown> } | null = null;

  /** Every setting this service reads, in one query, cached briefly. */
  private async settingsMap(): Promise<Map<string, unknown>> {
    const cached = PricingService.settingsCache;
    if (cached && Date.now() - cached.at < PricingService.SETTINGS_TTL_MS) return cached.byKey;

    const rows = await this.setting.findAll({ attributes: ["key", "value"] });
    const byKey = new Map<string, unknown>(rows.map((r) => [r.key, r.value as unknown]));
    PricingService.settingsCache = { at: Date.now(), byKey };
    return byKey;
  }

  /** Drop the cache so an admin edit takes effect at once. */
  static invalidateSettingsCache(): void {
    PricingService.settingsCache = null;
  }

  private async num(key: string, fallback: number | null = null): Promise<number | null> {
    const v = (await this.settingsMap()).get(key);
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Packaging rules, read from settings so the shop can change them without a
   * deploy. Wrapping is per piece; the outer box is once per order.
   */
  async packagingRules(): Promise<{
    wrapPerPieceG: number;
    outerPackagingG: number;
    defaultItemG: number;
    roundUpToKg: boolean;
  }> {
    // One cached read serves all four; this used to be four queries.
    const settings = await this.settingsMap();
    const [wrap, outer, fallback] = await Promise.all([
      this.num("shipping.wrapPerPieceG", 50),
      this.num("shipping.outerPackagingG", 200),
      this.num("shipping.defaultItemG", 500),
    ]);
    const raw = settings.get("shipping.roundUpToKg");
    return {
      wrapPerPieceG: wrap ?? 50,
      outerPackagingG: outer ?? 200,
      defaultItemG: fallback ?? 500,
      // Absent → on: the agreed flow rounds up, so the safe default is the one
      // that over-states rather than under-charges.
      roundUpToKg: raw === undefined || raw === null ? true : raw === true || raw === "true",
    };
  }

  /** Currency value of one loyalty point (Settings-driven; default ₹0.10). */
  async loyaltyPointValue(): Promise<number> {
    return (await this.num("loyalty.pointValue", 0.1)) ?? 0.1;
  }

  async compute(subtotal: number, discount = 0, express = false, freeDelivery = false, giftCardBalance = 0, loyaltyDiscount = 0, delivery: DeliveryContext = {}): Promise<PriceBreakdown> {
    this.logger.debug(`Pricing compute called with subtotal=${subtotal}, discount=${discount}, freeDelivery=${freeDelivery}, parcelG=${delivery.parcelG}, state=${delivery.state}, isPickup=${delivery.isPickup}`);
    const freeThreshold = await this.num("delivery.freeThreshold", null);

    const taxableBase = Math.max(subtotal - discount - loyaltyDiscount, 0);

    // Shelf prices are TAX-INCLUSIVE, so nothing is added on top at checkout:
    // the tax is already inside `subtotal`. Adding it again here charged the
    // customer for it twice.
    //
    // These two fields stay in the breakdown rather than being deleted: orders
    // placed before this change carry a real tax figure, and their invoices and
    // reports must keep rendering it. New orders simply carry zero, and the UI
    // hides a zero tax line.
    //
    // NOTE: the `tax.rate` setting is deliberately still read elsewhere — the
    // settlement engine uses it to deduct tax on the platform's own commission
    // when paying shops out. That is the business's own liability, unrelated to
    // what the customer is charged, and removing it would change every payout.
    const taxRate = 0;
    const tax = 0;

    // ── Delivery charge (weight × destination zone) ─────────────────────────────
    let deliveryFee: number;
    if (delivery.isPickup) {
      deliveryFee = 0;
    } else if (delivery.parcelG == null) {
      // No weight yet (the cart has no address, so no zone either) — the fee is
      // shown as "calculated at checkout" rather than guessed at.
      deliveryFee = 0;
    } else {
      const rate = this.shippingRates.feeFor(delivery.parcelG, delivery.state);
      if (rate == null) {
        throw new BadRequestException(
          "SHIPPING_RATE_MISSING: No delivery rate is configured for this destination.",
        );
      }
      const isFreeByThreshold = freeThreshold != null && subtotal >= freeThreshold;
      deliveryFee = freeDelivery || isFreeByThreshold ? 0 : rate;
    }

    const total = taxableBase + tax + deliveryFee;
    const giftCardDiscount = Math.min(giftCardBalance, total);
    const payableAmount = total - giftCardDiscount;
    
    this.logger.debug(`Pricing compute result: taxableBase=${taxableBase}, deliveryFee=${deliveryFee} (parcelG=${delivery.parcelG ?? "n/a"}, state=${delivery.state ?? "n/a"}), total=${total}, loyaltyDiscount=${loyaltyDiscount}, giftCardDiscount=${giftCardDiscount}, payableAmount=${payableAmount}`);
    return { taxableBase, tax, taxRate, deliveryFee, total, loyaltyDiscount, giftCardDiscount, payableAmount };
  }

  /** Collision-resistant human-readable order number. */
  orderNumber(): string {
    return `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  }
}
