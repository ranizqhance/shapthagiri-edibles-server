import { Body, Controller, Get, Module, Post, Patch, Put, Delete, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags, PartialType } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { DeliveryEngineService } from "./delivery-engine.service";
import { DeliveryHoliday, DeliveryZone, PeakMultiplier, Shop, ShopInventory, UserAddress, ProductVariant, Setting, ShippingCarrier, ShippingZone, ShippingRateBand } from "@/models";
import { Public } from "@/common/decorators/public.decorator";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { ActiveCarrierDto, DeliveryZoneDto, EstimateDto, HolidayDto, PeakMultiplierDto, ShippingZoneDto, ShippingRatesSaveDto } from "@/common/dto/common.dto";
import { PricingService } from "@/modules/orders/pricing.service";
import { ZoneCacheService } from "./zone-cache.service";
import { ShippingRateService } from "./shipping-rate.service";
import { InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { BadRequestException } from "@/common/errors/http";
import { Op } from "sequelize";

/*
 * PartialType(), not Partial<>.
 *
 * `Partial<T>` is a TypeScript-only construct: it erases to `Object` at
 * runtime, so Nest sees no DTO class, ValidationPipe skips the body entirely,
 * and `whitelist: true` strips nothing. These routes were accepting arbitrary
 * JSON straight into a model update. `PartialType` from @nestjs/swagger keeps
 * the validation metadata and only makes the fields optional.
 */
export class UpdateDeliveryZoneDto extends PartialType(DeliveryZoneDto) {}
export class UpdatePeakMultiplierDto extends PartialType(PeakMultiplierDto) {}
export class UpdateHolidayDto extends PartialType(HolidayDto) {}

@ApiTags("Delivery Engine")
@Controller("delivery-engine")
export class DeliveryEngineController {
  constructor(
    private engine: DeliveryEngineService,
    @InjectModel(DeliveryZone) private zone: typeof DeliveryZone,
    @InjectModel(PeakMultiplier) private peak: typeof PeakMultiplier,
    @InjectModel(DeliveryHoliday) private holiday: typeof DeliveryHoliday,
    @InjectModel(ShippingCarrier) private shippingCarrier: typeof ShippingCarrier,
    @InjectModel(ShippingZone) private shippingZone: typeof ShippingZone,
    @InjectModel(ShippingRateBand) private shippingBand: typeof ShippingRateBand,
    private readonly zoneCache: ZoneCacheService,
    private readonly shippingRates: ShippingRateService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  /**
   * Guards band integrity before persisting: valid range, unique code, and no overlap
   * with any other band (which also blocks exact duplicates). `excludeId` skips the row
   * being edited. Kept in the controller so both create + update share one gate.
   */
  private async validateZone(b: Partial<DeliveryZoneDto>, excludeId?: string) {
    const min = Number(b.distanceMinKm);
    const max = Number(b.distanceMaxKm);
    if (b.distanceMinKm != null && b.distanceMaxKm != null) {
      if (!(min >= 0)) throw new BadRequestException("VALIDATION_FAILED", "Minimum distance must be 0 or more");
      if (!(max > min)) throw new BadRequestException("VALIDATION_FAILED", "Maximum distance must be greater than minimum distance");
    }
    const others = await this.zone.findAll({ where: excludeId ? { id: { [Op.ne]: excludeId } } : {} });
    if (b.code && others.some((z) => z.code.toLowerCase() === String(b.code).toLowerCase())) {
      throw new BadRequestException("VALIDATION_FAILED", `Zone code "${b.code}" already exists`);
    }
    if (b.distanceMinKm != null && b.distanceMaxKm != null) {
      const clash = others.find((z) => min < Number(z.distanceMaxKm) && Number(z.distanceMinKm) < max);
      if (clash) throw new BadRequestException("VALIDATION_FAILED", `Range ${min}–${max} km overlaps zone "${clash.code}" (${clash.distanceMinKm}–${clash.distanceMaxKm} km)`);
    }
  }

  /** Smallest unused Z-code (≤4 chars). Admins never see it — it exists only so
   *  routing tags, shop.supportedZones and partner.zoneId keep referencing a code. */
  private async nextZoneCode(): Promise<string> {
    const existing = new Set((await this.zone.findAll({ attributes: ["code"] })).map((z) => z.code.toUpperCase()));
    for (let n = 1; n <= 999; n++) { const c = `Z${n}`; if (!existing.has(c)) return c; }
    return `Z${Math.floor(1000 + Math.random() * 8999)}`;
  }

  /** Fill the internal-only fields (code/label) the simplified UI omits. */
  private async buildZonePayload(b: DeliveryZoneDto) {
    const min = Number(b.distanceMinKm);
    const max = Number(b.distanceMaxKm);
    return {
      code: b.code?.trim() || (await this.nextZoneCode()),
      label: b.label?.trim() || `${min}–${max} km`,
      distanceMinKm: min,
      distanceMaxKm: max,
      deliveryFee: (b as any).deliveryFee === undefined ? null : (b as any).deliveryFee,
    };
  }

  @Public() @Post("estimate") estimate(@Body() b: EstimateDto) { return this.engine.estimate(b); }
  @Public() @Get("zones") zones() { return this.zone.findAll({ order: [["distanceMinKm", "ASC"]] }); }
  @ApiBearerAuth() @RequirePermissions("deliveryEngine.configure") @Post("zones") async createZone(@Body() b: DeliveryZoneDto) {
    const payload = await this.buildZonePayload(b);
    await this.validateZone(payload);
    const created = await this.zone.create(payload as any);
    await this.zoneCache.refresh();
    return created;
  }
  @ApiBearerAuth() @RequirePermissions("deliveryEngine.configure") @Patch("zones/:id") async updateZone(@Param("id") id: string, @Body() b: UpdateDeliveryZoneDto) {
    await this.validateZone(b, id);
    const patch: any = { ...b };
    // Keep the internal auto-label in sync when the range changes and the admin didn't
    // supply an explicit label (label is hidden in the simplified UI).
    if (patch.label == null && b.distanceMinKm != null && b.distanceMaxKm != null) {
      patch.label = `${Number(b.distanceMinKm)}–${Number(b.distanceMaxKm)} km`;
    }
    await this.zone.update(patch, { where: { id } });
    await this.zoneCache.refresh();
    return this.zone.findByPk(id);
  }
  @ApiBearerAuth() @RequirePermissions("deliveryEngine.configure") @Delete("zones/:id") async deleteZone(@Param("id") id: string) {
    await this.zone.destroy({ where: { id } });
    await this.zoneCache.refresh();
    return { deleted: true };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryEngine.view") @Get("peak-multipliers") peaks() { return this.peak.findAll(); }
  @ApiBearerAuth() @RequirePermissions("deliveryEngine.configure") @Post("peak-multipliers") createPeak(@Body() b: PeakMultiplierDto) { return this.peak.create(b as any); }
  @ApiBearerAuth() @RequirePermissions("deliveryEngine.configure") @Patch("peak-multipliers/:id") async updatePeak(@Param("id") id: string, @Body() b: UpdatePeakMultiplierDto) {
    await this.peak.update(b as any, { where: { id } });
    return this.peak.findByPk(id);
  }
  @ApiBearerAuth() @RequirePermissions("deliveryEngine.configure") @Delete("peak-multipliers/:id") async deletePeak(@Param("id") id: string) {
    await this.peak.destroy({ where: { id } });
    return { deleted: true };
  }

  @ApiBearerAuth() @RequirePermissions("deliveryEngine.view") @Get("holidays") holidays() { return this.holiday.findAll(); }
  @ApiBearerAuth() @RequirePermissions("deliveryEngine.configure") @Post("holidays") createHoliday(@Body() b: HolidayDto) { return this.holiday.create(b as any); }
  @ApiBearerAuth() @RequirePermissions("deliveryEngine.configure") @Patch("holidays/:id") async updateHoliday(@Param("id") id: string, @Body() b: UpdateHolidayDto) {
    await this.holiday.update(b, { where: { id } });
    return this.holiday.findByPk(id);
  }
  @ApiBearerAuth() @RequirePermissions("deliveryEngine.configure") @Delete("holidays/:id") async deleteHoliday(@Param("id") id: string) {
    await this.holiday.destroy({ where: { id } });
    return { deleted: true };
  }

  /* ──────────────────── Shipping rates (weight × zone) ────────────────────
   * The courier rate card. Distinct from the distance zones above, which decide
   * which shop can serve an address — these decide what the delivery costs.
   */

  /** Every configured courier, so the admin can switch between their cards. */
  @Public()
  @Get("shipping-carriers")
  async listCarriers() {
    const rows = await this.shippingCarrier.findAll({ order: [["name", "ASC"]] });
    return rows.map((c) => ({
      id: c.id, code: c.code, name: c.name, isActive: c.isActive, note: c.note ?? null,
    }));
  }

  /**
   * Make a carrier the one orders price on.
   *
   * Deactivating the others first, in a transaction, because the partial unique
   * index permits exactly one active row — setting the new one first would
   * collide.
   */
  @RequirePermissions("deliveryEngine.configure")
  @Put("shipping-carriers/active")
  async setActiveCarrier(@Body() b: ActiveCarrierDto) {
    const code = (b.code || "").trim().toUpperCase();
    const carrier = await this.shippingCarrier.findOne({ where: { code } });
    if (!carrier) throw new BadRequestException("NOT_FOUND", `No courier with code ${code}.`);

    const zoneCount = await this.shippingZone.count({ where: { carrierId: carrier.id, isActive: true } });
    if (!zoneCount) {
      // Switching to an empty card would make every checkout fail with
      // SHIPPING_RATE_MISSING, which is a worse outcome than refusing here.
      throw new BadRequestException(
        "VALIDATION_FAILED",
        `${carrier.name} has no rates configured — add them before making it active.`,
      );
    }

    await this.sequelize.transaction(async (t) => {
      await this.shippingCarrier.update({ isActive: false }, { where: {}, transaction: t });
      await carrier.update({ isActive: true }, { transaction: t });
    });

    await this.shippingRates.refresh();
    return { code: carrier.code, name: carrier.name, isActive: true };
  }

  /**
   * One courier's rate card. Defaults to the active courier, so an unscoped
   * call returns the rates orders are actually priced on.
   */
  @Public()
  @Get("shipping-rates")
  async listShippingRates(@Query("carrier") carrierCode?: string) {
    const carrier = await this.resolveCarrier(carrierCode);
    const zones = await this.shippingZone.findAll({
      where: carrier ? { carrierId: carrier.id } : {},
      include: [{ model: ShippingRateBand }],
      order: [["isDefault", "ASC"], ["name", "ASC"]],
    });
    return zones.map((z) => ({
      id: z.id,
      carrierCode: carrier?.code ?? null,
      code: z.code,
      name: z.name,
      states: z.states ?? [],
      isDefault: z.isDefault,
      perKgAboveTopBand: Number(z.perKgAboveTopBand ?? 0),
      bands: (z.bands ?? [])
        .map((b) => ({ id: b.id, minG: Number(b.minG), maxG: Number(b.maxG), charge: Number(b.charge) }))
        .sort((a, b) => a.minG - b.minG),
    }));
  }

  /**
   * Replace the whole grid in one call.
   *
   * A rate card is edited as a matrix and saved once, so per-cell CRUD would
   * mean a dozen round trips and a half-saved card if one failed. Bands are
   * rewritten wholesale per zone inside a transaction; zones are matched by
   * code so ids survive.
   */
  @RequirePermissions("deliveryEngine.configure")
  @Put("shipping-rates")
  async saveShippingRates(@Body() body: ShippingRatesSaveDto, @Query("carrier") carrierCode?: string) {
    const carrier = await this.resolveCarrier(carrierCode);
    if (!carrier) {
      throw new BadRequestException("VALIDATION_FAILED", "No courier to save these rates against.");
    }
    const defaults = body.zones.filter((z) => z.isDefault);
    if (defaults.length !== 1) {
      throw new BadRequestException(
        "VALIDATION_FAILED",
        "Exactly one zone must be the default, to catch states no other zone lists.",
      );
    }
    for (const z of body.zones) this.validateBands(z);

    await this.sequelize.transaction(async (t) => {
      for (const z of body.zones) {
        const code = (z.code || z.name).trim().toUpperCase().slice(0, 16);
        const [zone] = await this.shippingZone.findOrCreate({
          where: { carrierId: carrier.id, code },
          defaults: {
            carrierId: carrier.id,
            code,
            name: z.name,
            states: z.states ?? [],
            isDefault: !!z.isDefault,
            perKgAboveTopBand: z.perKgAboveTopBand ?? 0,
          } as any,
          transaction: t,
        });
        await zone.update(
          {
            name: z.name,
            states: z.states ?? [],
            isDefault: !!z.isDefault,
            perKgAboveTopBand: z.perKgAboveTopBand ?? 0,
          },
          { transaction: t },
        );
        if (z.bands) {
          await this.shippingBand.destroy({ where: { zoneId: zone.id }, transaction: t });
          await this.shippingBand.bulkCreate(
            z.bands.map((b) => ({ zoneId: zone.id, minG: b.minG, maxG: b.maxG, charge: b.charge })) as any,
            { transaction: t },
          );
        }
      }
    });

    await this.shippingRates.refresh();
    return this.listShippingRates(carrier.code);
  }

  /**
   * The carrier a request is about: the one named, else the active one.
   *
   * Returns null only on a database that predates the carrier table, where the
   * zones are India Post's by definition and scoping is meaningless.
   */
  private async resolveCarrier(code?: string) {
    if (code) {
      const hit = await this.shippingCarrier.findOne({ where: { code: code.trim().toUpperCase() } });
      if (!hit) throw new BadRequestException("NOT_FOUND", `No courier with code ${code}.`);
      return hit;
    }
    return this.shippingCarrier.findOne({ where: { isActive: true } });
  }

  @RequirePermissions("deliveryEngine.configure")
  @Delete("shipping-zones/:id")
  async deleteShippingZone(@Param("id") id: string) {
    const zone = await this.shippingZone.findByPk(id);
    if (!zone) throw new BadRequestException("NOT_FOUND", "Shipping zone not found");
    if (zone.isDefault) {
      // Without a catch-all, any state nobody listed would have no rate at all
      // and checkout would fail for them.
      throw new BadRequestException("VALIDATION_FAILED", "The default zone cannot be deleted.");
    }
    await this.shippingBand.destroy({ where: { zoneId: id } });
    await zone.destroy();
    await this.shippingRates.refresh();
    return { deleted: true };
  }

  /**
   * Rows must be ordered and contiguous. A gap would leave some parcel weight
   * with no price at all, and an overlap would make the charge depend on row
   * order — both silently mis-bill rather than failing loudly.
   */
  private validateBands(z: ShippingZoneDto) {
    const bands = [...(z.bands ?? [])].sort((a, b) => a.minG - b.minG);
    if (!bands.length) return;
    for (const b of bands) {
      if (b.maxG <= b.minG) {
        throw new BadRequestException("VALIDATION_FAILED", `${z.name}: a row must end above where it starts.`);
      }
    }
    for (let i = 1; i < bands.length; i++) {
      if (bands[i].minG !== bands[i - 1].maxG) {
        throw new BadRequestException(
          "VALIDATION_FAILED",
          `${z.name}: rows must run continuously — ${bands[i - 1].maxG} g is followed by ${bands[i].minG} g.`,
        );
      }
    }
  }
}

@Module({
  imports: [SequelizeModule.forFeature([Shop, ShopInventory, UserAddress, DeliveryZone, PeakMultiplier, DeliveryHoliday, ProductVariant, Setting, ShippingCarrier, ShippingZone, ShippingRateBand])],
  controllers: [DeliveryEngineController],
  providers: [DeliveryEngineService, PricingService],
  exports: [DeliveryEngineService],
})
export class DeliveryEngineModule {}
