import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { ShippingCarrier, ShippingZone, ShippingRateBand } from "@/models";

/** A zone and its bands, flattened and pre-sorted for lookup. */
export interface ResolvedZone {
  id: string;
  code: string;
  name: string;
  states: string[];
  isDefault: boolean;
  perKgAboveTopBand: number;
  /** Ascending by minG. */
  bands: { minG: number; maxG: number; charge: number }[];
}

/** What a lookup actually matched — the simulator and the admin UI both show this. */
export interface ShippingQuote {
  fee: number;
  /** Which courier's card produced this, so an order can record what it was priced on. */
  carrierCode: string;
  carrierName: string;
  zoneCode: string;
  zoneName: string;
  /** null when the parcel went past the heaviest band and per-kg pricing applied. */
  band: { minG: number; maxG: number; charge: number } | null;
  /** Kilograms charged at the per-kg rate above the top band. */
  extraKg: number;
}

/**
 * The courier rate card, held in memory.
 *
 * Mirrors ZoneCacheService: this is read on every pricing call, so it must not
 * hit the database each time, and every admin mutation calls refresh().
 *
 * Note this is NOT the same thing as a DeliveryZone. That is a distance band
 * deciding which shop can serve an address; this decides what the courier
 * charges to reach it.
 */
@Injectable()
export class ShippingRateService implements OnModuleInit {
  private readonly logger = new Logger(ShippingRateService.name);
  private zones: ResolvedZone[] = [];
  /**
   * When an empty cache last tried to reload itself. Boot can legitimately find
   * no rate card — the tables may not exist yet — and without this the service
   * stays empty until someone restarts the process, which is how a migration
   * turned into an outage. Rate-limited so a genuinely unconfigured install
   * does not re-query on every single pricing call.
   */
  private lastEmptyReload = 0;
  private static readonly EMPTY_RELOAD_MS = 30_000;

  /** The active carrier, whose card `zones` holds. */
  private carrier: { id: string; code: string; name: string } | null = null;

  constructor(
    @InjectModel(ShippingCarrier) private carrierModel: typeof ShippingCarrier,
    @InjectModel(ShippingZone) private zoneModel: typeof ShippingZone,
    @InjectModel(ShippingRateBand) private bandModel: typeof ShippingRateBand,
  ) {}

  async onModuleInit() {
    try {
      await this.refresh();
    } catch (e: any) {
      // A missing table on first boot must not stop the app; pricing then falls
      // back to zero and logs, rather than crashing every checkout.
      this.logger.warn(`Shipping rates unavailable at boot: ${e?.message}`);
      this.zones = [];
    }
  }

  /**
   * Load the active carrier's card.
   *
   * Only one carrier's zones are ever held: the others' rates exist to be
   * edited and switched to, not to be quoted from. Loading them all would mean
   * every lookup had to filter, and a stray zone from the wrong courier would
   * silently mis-price.
   */
  async refresh() {
    const carrier = await this.carrierModel.findOne({ where: { isActive: true } });
    if (!carrier) {
      // Before 005 there are no carriers at all; the zones are India Post's.
      this.carrier = null;
      this.logger.warn("No active shipping carrier — falling back to every configured zone");
    } else {
      this.carrier = { id: carrier.id, code: carrier.code, name: carrier.name };
    }

    const rows = await this.zoneModel.findAll({
      where: { isActive: true, ...(this.carrier ? { carrierId: this.carrier.id } : {}) },
      include: [{ model: ShippingRateBand }],
    });
    this.zones = rows.map((z) => ({
      id: z.id,
      code: z.code,
      name: z.name,
      states: Array.isArray(z.states) ? z.states : [],
      isDefault: !!z.isDefault,
      perKgAboveTopBand: Number(z.perKgAboveTopBand ?? 0),
      bands: (z.bands ?? [])
        .map((b) => ({ minG: Number(b.minG), maxG: Number(b.maxG), charge: Number(b.charge) }))
        .sort((a, b) => a.minG - b.minG),
    }));
    this.logger.log(
      `Shipping rates loaded: ${this.zones.length} zone(s)` +
        (this.carrier ? ` for ${this.carrier.name}` : ""),
    );
  }

  /** The carrier orders currently price on. */
  get activeCarrier(): { id: string; code: string; name: string } | null {
    return this.carrier;
  }

  get loaded(): boolean {
    return this.zones.length > 0;
  }

  /** Every zone with its bands — backs the admin grid and the simulator. */
  snapshot(): ResolvedZone[] {
    return this.zones;
  }

  /**
   * Which zone a delivery state belongs to.
   *
   * Matched case-insensitively on a trimmed string, because address states are
   * free text: "kerala", " Kerala " and "KERALA" are all the same place.
   * Anything unmatched — including a missing state — falls to the default zone.
   */
  resolveZone(state?: string | null): ResolvedZone | null {
    const key = (state ?? "").trim().toLowerCase();
    if (key) {
      const hit = this.zones.find((z) => z.states.some((s) => s.trim().toLowerCase() === key));
      if (hit) return hit;
    }
    return this.zones.find((z) => z.isDefault) ?? this.zones[0] ?? null;
  }

  /**
   * Price a parcel, in grams.
   *
   * Bands are UPPER-inclusive, matching the card's "Weight upto gm" heading: a
   * 1,000 g parcel is priced by the 1,000 g row, not the next one. Callers pass
   * the already-rounded `chargeableG` from computeParcelWeight().
   *
   * Past the heaviest row the top charge applies plus a per-kg rate for every
   * whole kilogram over — the card stops at 35 kg, and without this a 60 kg
   * parcel would ship at the 35 kg price.
   */
  quote(parcelG: number, state?: string | null): ShippingQuote | null {
    // Nothing cached: the card may have arrived since boot.
    if (!this.zones.length) void this.reloadIfEmpty();

    const zone = this.resolveZone(state);
    if (!zone || !zone.bands.length) return null;

    const w = Math.max(0, Math.round(Number(parcelG) || 0));
    const who = {
      carrierCode: this.carrier?.code ?? "",
      carrierName: this.carrier?.name ?? "",
      zoneCode: zone.code,
      zoneName: zone.name,
    };

    const band = zone.bands.find((b) => w > b.minG && w <= b.maxG);
    if (band) {
      return { fee: band.charge, ...who, band, extraKg: 0 };
    }

    // Lighter than the first row (only reachable with rounding off) — cheapest rate.
    const first = zone.bands[0];
    if (w <= first.minG) {
      return { fee: first.charge, ...who, band: first, extraKg: 0 };
    }

    // Past the heaviest row. For a table-shaped card this is the overweight
    // tail; for a "base + per kg" card it is the ordinary case, and the single
    // band below 1 kg means every heavier parcel lands here.
    const top = zone.bands[zone.bands.length - 1];
    const extraKg = Math.max(0, Math.ceil((w - top.maxG) / 1000));
    return {
      fee: Number((top.charge + extraKg * zone.perKgAboveTopBand).toFixed(2)),
      ...who,
      band: null,
      extraKg,
    };
  }

  /**
   * Re-read the card when the cache is empty, at most once per window.
   *
   * Deliberately fire-and-forget: pricing must not block on a database round
   * trip, so the call that finds the cache empty still fails, and the next one
   * succeeds. That turns "restart the API after migrating" into a few seconds
   * of degradation instead of a manual step nobody remembers.
   */
  private async reloadIfEmpty(): Promise<void> {
    const now = Date.now();
    if (now - this.lastEmptyReload < ShippingRateService.EMPTY_RELOAD_MS) return;
    this.lastEmptyReload = now;
    try {
      await this.refresh();
    } catch (e: any) {
      this.logger.warn(`Shipping rate reload failed: ${e?.message}`);
    }
  }

  /** Just the number, for the pricing path. Null when no rate card is configured. */
  feeFor(parcelG: number, state?: string | null): number | null {
    return this.quote(parcelG, state)?.fee ?? null;
  }
}
