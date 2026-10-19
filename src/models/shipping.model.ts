import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, ForeignKey, BelongsTo, HasMany } from "sequelize-typescript";

/**
 * A courier the shop can ship with, each carrying its own rate card.
 *
 * The shop holds accounts with more than one — India Post Speed Post and a
 * private courier — and their cards have different shapes: India Post prices
 * from a 37-row table, the private courier from a base rate plus a per-kilogram
 * amount. Both are just zones and bands, so the engine needs no special case;
 * what it needs is to know WHICH card is in force.
 *
 * Exactly one carrier is active at a time. Orders price on that one, and
 * switching is a single flag rather than a re-entry of every rate.
 */
@Table({ tableName: "shipping_carriers", timestamps: true })
export class ShippingCarrier extends Model<ShippingCarrier> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Unique @Column(DataType.STRING(24)) declare code: string;
  @AllowNull(false) @Column(DataType.STRING(60)) declare name: string;

  /**
   * The one whose rates apply. Enforced by a partial unique index rather than
   * application code, so two active carriers cannot exist even briefly — the
   * charge a customer is quoted must never depend on which row was read first.
   */
  @Default(false) @Column(DataType.BOOLEAN) declare isActive: boolean;

  /** Shown on the admin screen so whoever edits a rate knows what they are reading. */
  @Column(DataType.STRING(200)) declare note: string | null;

  @HasMany(() => ShippingZone) declare zones?: ShippingZone[];
}

/**
 * A destination tier for courier pricing — e.g. "Kerala" vs everywhere else.
 *
 * Distinct from `DeliveryZone`, which is a *distance* band used for shop
 * serviceability and partner routing. This one is about where the parcel is
 * going, not how far the shop is from the customer, and only ever decides price.
 *
 * Zones are rows rather than a hardcoded "Kerala" check so the rate card can be
 * edited without a deploy, and a third tier can be added later.
 */
@Table({ tableName: "shipping_zones", timestamps: true })
export class ShippingZone extends Model<ShippingZone> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  /**
   * Which courier's card this zone belongs to. Zone codes repeat across
   * carriers — both have a Kerala tier — so `code` is unique per carrier, not
   * globally.
   */
  @ForeignKey(() => ShippingCarrier) @AllowNull(false) @Column(DataType.UUID) declare carrierId: string;

  @AllowNull(false) @Column(DataType.STRING(16)) declare code: string;
  @AllowNull(false) @Column(DataType.STRING(60)) declare name: string;

  /**
   * Delivery-address states this zone covers, matched case-insensitively after
   * trimming. Empty on the default zone, which catches everything unmatched.
   */
  @AllowNull(false) @Default([]) @Column(DataType.JSONB) declare states: string[];

  /**
   * The catch-all. Exactly one zone carries this, and it cannot be deleted —
   * without it an unrecognised state would have no rate at all.
   */
  @Default(false) @Column(DataType.BOOLEAN) declare isDefault: boolean;

  /**
   * Charged for each whole kilogram past the heaviest band, on top of that
   * band's rate.
   *
   * Carries the whole weight of a "base + per kg" card: a single 0–1,000 g band
   * at the base rate plus this amount prices "up to 1 kg Rs 70, each additional
   * kg Rs 50" exactly. For a table-shaped card like India Post's it only covers
   * parcels past the heaviest row — without it a 60 kg parcel would ship at the
   * 35 kg price.
   */
  @AllowNull(false) @Default(0) @Column(DataType.DECIMAL(10, 2)) declare perKgAboveTopBand: number;

  @Default(true) @Column(DataType.BOOLEAN) declare isActive: boolean;

  @BelongsTo(() => ShippingCarrier) declare carrier?: ShippingCarrier;
  @HasMany(() => ShippingRateBand) declare bands?: ShippingRateBand[];
}

/**
 * One row of a zone's rate card: a parcel over `minG` and up to `maxG` costs `charge`.
 *
 * Grams, not kilograms — the courier's card is headed "Weight upto gm" and the
 * admin screen mirrors it, so storing kilograms would mean converting at exactly
 * the boundaries where a rounding slip changes what the customer pays.
 *
 * Bounds are UPPER-INCLUSIVE (`minG < w <= maxG`), matching "upto": a 1,000 g
 * parcel belongs to the 1,000 g row, not the next one up. This is the opposite
 * of the distance bands, and getting it backwards pushes every exact-kilogram
 * parcel into the next band.
 */
@Table({ tableName: "shipping_rate_bands", timestamps: true })
export class ShippingRateBand extends Model<ShippingRateBand> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => ShippingZone) @AllowNull(false) @Column(DataType.UUID) declare zoneId: string;
  @AllowNull(false) @Column(DataType.INTEGER) declare minG: number;
  @AllowNull(false) @Column(DataType.INTEGER) declare maxG: number;
  @AllowNull(false) @Column(DataType.DECIMAL(10, 2)) declare charge: number;

  @BelongsTo(() => ShippingZone) declare zone?: ShippingZone;
}
