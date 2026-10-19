import { Injectable } from "@nestjs/common";
import { Op } from "sequelize";
import { InjectModel } from "@nestjs/sequelize";
import { Shop, ShopInventory, UserAddress, ProductVariant } from "@/models";
import { haversineKm } from "@/common/utils/geo.util";
import { AddressNotServiceableException, NoShopHasStockException } from "@/common/errors/domain";
import { PricingService } from "@/modules/orders/pricing.service";
import { ZoneCacheService } from "./zone-cache.service";
import { computeParcelWeight } from "@/common/utils/order-weight.util";

export interface CartItemInput { variantId: string; quantity: number; }
export interface EtaRequest {
  addressId?: string; lat?: number; lng?: number;
  items: CartItemInput[]; express?: boolean;
  freeDelivery?: boolean;
  /** Destination state — picks the shipping zone. Resolved from addressId when omitted. */
  state?: string | null;
  // Single-serving-shop: pin fulfilment to this shop only (no cross-shop routing).
  preferredShopId?: string;
}
export interface ShopAssignment {
  shopId: string; shopName: string; items: CartItemInput[]; distanceKm: number; zone: string;
}

@Injectable()
export class DeliveryEngineService {
  constructor(
    @InjectModel(Shop) private shop: typeof Shop,
    @InjectModel(ShopInventory) private inv: typeof ShopInventory,
    @InjectModel(UserAddress) private addr: typeof UserAddress,
    @InjectModel(ProductVariant) private variant: typeof ProductVariant,
    private pricing: PricingService,
    private zoneCache: ZoneCacheService,
  ) {}

  /**
   * Where the parcel is going.
   *
   * Returns the state alongside the coordinates: coordinates pick the shop,
   * the state picks the shipping zone that prices the delivery. An explicit
   * `state` on the request wins, so a caller that already has the address
   * snapshot (order placement) does not need a second lookup.
   */
  async resolveDestination(req: EtaRequest): Promise<{ lat: number; lng: number; state: string | null }> {
    if (req.lat !== undefined && req.lng !== undefined) {
      return { lat: req.lat, lng: req.lng, state: req.state ?? null };
    }
    if (req.addressId) {
      const a = await this.addr.findByPk(req.addressId);
      if (!a || a.lat == null || a.lng == null) throw new AddressNotServiceableException();
      return { lat: Number(a.lat), lng: Number(a.lng), state: req.state ?? a.state ?? null };
    }
    throw new AddressNotServiceableException();
  }

  async selectShopsPerItem(items: CartItemInput[], dLat: number, dLng: number, preferredShopId?: string): Promise<ShopAssignment[]> {
    // Shops and inventory in two queries, not one inventory query per cart item.
    // This runs inside the order-placement transaction, so every extra round
    // trip here holds row locks open for longer.
    const [shops, allRows] = await Promise.all([
      this.shop.findAll({ where: { isActive: true } }),
      this.inv.findAll({
        where: { variantId: { [Op.in]: [...new Set(items.map((i) => i.variantId))] }, isActive: true },
        attributes: ["id", "variantId", "shopId", "quantity", "isActive"],
      }),
    ]);
    const rowsByVariant = new Map<string, typeof allRows>();
    for (const r of allRows) {
      const list = rowsByVariant.get(r.variantId) ?? [];
      list.push(r);
      rowsByVariant.set(r.variantId, list);
    }

    const map = new Map<string, ShopAssignment>();
    for (const item of items) {
      let rows = rowsByVariant.get(item.variantId) ?? [];
      // Single-serving-shop: only the serving shop may fulfil (no routing elsewhere).
      if (preferredShopId) rows = rows.filter((r) => r.shopId === preferredShopId);
      const candidates = rows
        .filter((r) => r.quantity >= item.quantity)
        .map((r) => {
          const s = shops.find((sh) => sh.id === r.shopId);
          if (!s) {
            return null;
          }
          const distanceKm = haversineKm(dLat, dLng, Number(s.lat), Number(s.lng));
          
          // Check delivery radius
          const maxRadius = s.deliveryRadiusKm != null ? Number(s.deliveryRadiusKm) : 15;
          if (distanceKm > maxRadius) {
            return null;
          }

          // Check supported zones — skipped when pinned to the serving shop, which
          // was already deemed serviceable at browse time (nearest-shop resolution).
          const zoneCode = this.zoneCache.bandForDistance(distanceKm).code;
          if (!preferredShopId && s.supportedZones && s.supportedZones.length > 0) {
            if (!s.supportedZones.includes(zoneCode)) {
              return null;
            }
          }

          return { shopId: r.shopId, shop: s, distanceKm };
        })
        .filter((c): c is NonNullable<typeof c> => !!c)
        .sort((a, b) => a.distanceKm - b.distanceKm);
      
      if (!candidates.length) {
        console.error(`[STOCK_VALIDATION] Throwing RT_NO_STOCK_ANYWHERE for variantId ${item.variantId}`);
        throw new NoShopHasStockException();
      }
      const c = candidates[0];
      const ex = map.get(c.shopId);
      if (ex) ex.items.push(item);
      else map.set(c.shopId, { shopId: c.shopId, shopName: c.shop.name, items: [item], distanceKm: c.distanceKm, zone: this.zoneCache.bandForDistance(c.distanceKm).code });
    }
    return Array.from(map.values());
  }

  async estimate(req: EtaRequest) {
    const { lat, lng, state } = await this.resolveDestination(req);
    const assignments = await this.selectShopsPerItem(req.items, lat, lng, req.preferredShopId);
    const farthest = assignments.reduce((m, a) => (a.distanceKm > m.distanceKm ? a : m), assignments[0]);
    const zone = this.zoneCache.bandForDistance(farthest.distanceKm);

    // Subtotal and weight from the same variant rows, in one query rather than
    // one per line.
    const lines = req.items ?? [];
    const variants = lines.length
      ? await this.variant.findAll({ where: { id: lines.map((i) => i.variantId) } })
      : [];
    const byId = new Map(variants.map((v) => [v.id, v]));
    const subtotal = lines.reduce(
      (s, it) => s + Number(byId.get(it.variantId)?.defaultPrice ?? 0) * it.quantity,
      0,
    );

    // The preview must agree with what checkout charges, so it prices the same
    // way: total weight against the destination zone.
    const parcel = computeParcelWeight(
      lines.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      variants as any,
      await this.pricing.packagingRules(),
    );
    const priceBreakdown = await this.pricing.compute(
      subtotal, 0, req.express, req.freeDelivery, 0, 0,
      { parcelG: parcel.chargeableG, state },
    );

    return {
      assignments, farthestShop: farthest,
      zone: zone.code, distanceKm: farthest.distanceKm,
      deliveryFee: priceBreakdown.deliveryFee,
      // The whole working, so checkout prices consistently without recomputing
      // weight in the browser and the admin simulator can explain the charge.
      parcelG: parcel.parcelG,
      chargeableG: parcel.chargeableG,
      productG: parcel.productG,
      wrapG: parcel.wrapG,
      outerG: parcel.outerG,
      pieces: parcel.pieces,
      shippingState: state,
    };
  }
}
