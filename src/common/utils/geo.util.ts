export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Seed-only defaults. The `delivery_zones` DB table is the single source of truth for
 * band resolution at runtime (see ZoneCacheService) — this array is used ONLY to seed
 * an empty table so a fresh install keeps working. `max: 99999` stands in for "no upper
 * bound" (DECIMAL can't hold Infinity). Do not resolve bands from this at runtime.
 */
export const DEFAULT_ZONES = [
  { code: "A", label: "Local",    min: 0,   max: 10 },
  { code: "B", label: "Metro",    min: 10,  max: 50 },
  { code: "C", label: "Regional", min: 50,  max: 200 },
  { code: "D", label: "National", min: 200, max: 500 },
  { code: "E", label: "Remote",   min: 500, max: 99999 },
] as const;

export interface ResolvedBand {
  code: string; label: string; min: number; max: number; deliveryFee: number | null;
}

/** Pure band lookup over a pre-sorted band list. Clamps to the last band when the
 *  distance exceeds every configured range (business rule). Returns null if empty. */
export function resolveBand(bands: ResolvedBand[], km: number): ResolvedBand | null {
  if (!bands.length) return null;
  return bands.find((z) => km >= z.min && km < z.max) ?? null;
}
