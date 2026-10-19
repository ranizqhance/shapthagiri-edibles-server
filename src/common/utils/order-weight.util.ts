/**
 * What the parcel actually weighs on the courier's scale.
 *
 * Products alone are not what ships. Each piece is wrapped separately and the
 * whole lot goes into one outer box, and India Post bills on the total — so
 * pricing bare product weight under-charges every order, often by a whole band.
 *
 * The three constants live in settings so the shop can change them without a
 * deploy; the caller reads them and passes them in.
 */
export interface WeighableLine {
  variantId: string;
  quantity: number;
}

export interface WeightedVariant {
  id: string;
  /** Stored in kilograms at 3dp, which is gram precision. */
  weightKg?: number | null;
}

export interface ParcelWeightOptions {
  /** Wrapping added per PIECE, not per line — 3 units means 3 wraps. */
  wrapPerPieceG: number;
  /** The outer box, once for the whole order. */
  outerPackagingG: number;
  /** Assumed weight for a variant that has none recorded. */
  defaultItemG: number;
  /**
   * Round the parcel up to a whole kilogram before it is priced. The courier's
   * card has 500 g and 1,500 g rows, so this deliberately over-states light
   * parcels; it is on because the agreed flow calls for it.
   */
  roundUpToKg: boolean;
}

export interface ParcelWeight {
  /** Products only, before packaging. */
  productG: number;
  /** Total units across the order. */
  pieces: number;
  wrapG: number;
  outerG: number;
  /** What the parcel really weighs. */
  parcelG: number;
  /** What it is priced as, after any rounding up. */
  chargeableG: number;
  /** Variants with no recorded weight, which fell back to the default. */
  missing: string[];
}

export function computeParcelWeight(
  lines: WeighableLine[],
  variants: WeightedVariant[],
  opts: ParcelWeightOptions,
): ParcelWeight {
  const byId = new Map(variants.map((v) => [v.id, v]));
  const missing: string[] = [];
  let productG = 0;
  let pieces = 0;

  for (const line of lines) {
    const qty = Math.max(0, Math.trunc(Number(line.quantity) || 0));
    if (!qty) continue;
    pieces += qty;

    const raw = byId.get(line.variantId)?.weightKg;
    const eachG = raw == null || Number(raw) <= 0 ? null : Math.round(Number(raw) * 1000);
    if (eachG == null) missing.push(line.variantId);
    productG += (eachG ?? opts.defaultItemG) * qty;
  }

  const wrapG = pieces * Math.max(0, opts.wrapPerPieceG);
  // The outer box only exists if something is in it.
  const outerG = pieces > 0 ? Math.max(0, opts.outerPackagingG) : 0;
  const parcelG = productG + wrapG + outerG;

  // Any part of a kilogram counts as a whole one, and nothing ships as 0 kg —
  // but an empty order stays empty rather than being billed for a phantom kilo.
  const chargeableG =
    opts.roundUpToKg && parcelG > 0 ? Math.max(1, Math.ceil(parcelG / 1000)) * 1000 : parcelG;

  return { productG, pieces, wrapG, outerG, parcelG, chargeableG, missing };
}
