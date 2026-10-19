import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { DeliveryZone } from "@/models";
import { DEFAULT_ZONES, ResolvedBand, resolveBand } from "@/common/utils/geo.util";

/**
 * Single source of truth for delivery distance bands.
 *
 * The `delivery_zones` DB table (managed in Admin → Zones & SLA) drives band
 * resolution for routing zone tagging, SLA/ETA windows AND delivery charges — no
 * more hardcoded zone array. Bands are cached in memory (sync lookup on the hot
 * checkout path) and refreshed whenever a zone is created/updated/deleted.
 *
 * On first boot an empty table is seeded from DEFAULT_ZONES (fees left NULL) so an
 * existing install behaves identically until an admin configures per-band charges.
 */
@Injectable()
export class ZoneCacheService implements OnModuleInit {
  private readonly logger = new Logger(ZoneCacheService.name);
  private bands: ResolvedBand[] = [];

  constructor(@InjectModel(DeliveryZone) private readonly zoneModel: typeof DeliveryZone) {}

  async onModuleInit() {
    await this.seedIfEmpty();
    try {
      await this.refresh();
    } catch (e: any) {
      // Boot must not die because the schema is not there yet. seedIfEmpty()
      // already swallows its own failure, so an unguarded refresh() turned a
      // missing `delivery_zones` table into an unhandled rejection that killed
      // the process during onModuleInit — before app.listen() ever ran.
      // Leaving `bands` empty degrades delivery pricing (PricingService raises
      // OUT_OF_ZONE) instead of taking the whole API down.
      this.logger.error(
        `Zone cache unavailable: ${e?.message}. Delivery pricing will reject until ` +
        `the schema exists — run \`node dist/scripts/sync-db.js\` against this database.`,
      );
      this.bands = [];
    }
  }

  private async seedIfEmpty() {
    try {
      const count = await this.zoneModel.count();
      if (count > 0) return;
      await this.zoneModel.bulkCreate(
        DEFAULT_ZONES.map((z) => ({
          code: z.code, label: z.label,
          distanceMinKm: z.min, distanceMaxKm: z.max,
          deliveryFee: null,
        })) as any,
      );
      this.logger.log(`Seeded ${DEFAULT_ZONES.length} default delivery zones (fees unset)`);
    } catch (e: any) {
      this.logger.error(`Zone seed skipped: ${e?.message}`);
    }
  }

  /** Reload the cache from the DB, sorted by ascending min distance. */
  async refresh() {
    const rows = await this.zoneModel.findAll({ order: [["distanceMinKm", "ASC"]] });
    this.bands = rows.map((r) => ({
      code: r.code, label: r.label,
      min: Number(r.distanceMinKm), max: Number(r.distanceMaxKm),
      deliveryFee: r.deliveryFee == null ? null : Number(r.deliveryFee),
    }));
  }

  all(): ResolvedBand[] {
    return this.bands;
  }

  /**
   * The band a distance falls into. Clamps to the last band beyond the max range.
   * Falls back to DEFAULT_ZONES only if the cache is somehow empty (never null in
   * practice after seeding) so routing/pricing never breaks.
   */
  bandForDistance(km: number): ResolvedBand {
    const fromDb = resolveBand(this.bands, km);
    if (fromDb) return fromDb;
    const fallback = DEFAULT_ZONES.map((z) => ({
      code: z.code, label: z.label, min: z.min, max: z.max, deliveryFee: null,
    }));
    return resolveBand(fallback, km)!;
  }

  /** Configured delivery charge for a distance, or null when the band has no fee set. */
  deliveryFeeForDistance(km: number): number | null {
    return this.bandForDistance(km).deliveryFee;
  }
}
