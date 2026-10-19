import { Global, Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { DeliveryZone, ShippingCarrier, ShippingZone, ShippingRateBand } from "@/models";
import { ZoneCacheService } from "./zone-cache.service";
import { ShippingRateService } from "./shipping-rate.service";

/**
 * Global so the delivery caches are injectable everywhere (PricingService in the
 * orders module + DeliveryEngineService) without creating a circular module import —
 * delivery-engine already depends on orders' PricingService.
 *
 * Holds two distinct things: ZoneCacheService (distance bands, for serviceability
 * and routing) and ShippingRateService (the courier rate card, for price).
 */
@Global()
@Module({
  imports: [SequelizeModule.forFeature([DeliveryZone, ShippingCarrier, ShippingZone, ShippingRateBand])],
  providers: [ZoneCacheService, ShippingRateService],
  exports: [ZoneCacheService, ShippingRateService],
})
export class ZoneModule {}
