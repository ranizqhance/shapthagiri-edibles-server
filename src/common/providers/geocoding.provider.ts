import { logger } from "@/common/utils/logger";
import { BRAND } from "@/common/brand";

// Nominatim asks every client to identify itself.
const USER_AGENT = `${BRAND.wordmark.charAt(0)}${BRAND.wordmark.slice(1).toLowerCase()}/1.0 (storefront delivery geocoding; ${BRAND.website})`;

/**
 * Nominatim's usage policy allows at most ~1 request/second per application and
 * answers 429 when exceeded. The storefront geocodes on every address save, and
 * the client tries progressively coarser queries, so bursts are easy to produce.
 * Without a cache and a throttle the whole location feature silently degrades to
 * "address not found" — which is indistinguishable from a genuinely bad address.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // places don't move
const MISS_TTL_MS = 10 * 60 * 1000;       // retry a miss sooner than a hit
const MIN_INTERVAL_MS = 1100;             // stay just under 1 req/s

interface CacheEntry<T> { value: T; expiresAt: number }

class UpstreamLimiter {
  private cache = new Map<string, CacheEntry<any>>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  get<T>(key: string): { hit: true; value: T } | { hit: false } {
    const e = this.cache.get(key);
    if (!e) return { hit: false };
    if (Date.now() > e.expiresAt) { this.cache.delete(key); return { hit: false }; }
    return { hit: true, value: e.value as T };
  }

  set<T>(key: string, value: T, isMiss: boolean) {
    // Bound the map so a long-running process can't grow it without limit.
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(key, { value, expiresAt: Date.now() + (isMiss ? MISS_TTL_MS : CACHE_TTL_MS) });
  }

  /** Serialise calls and space them out, so we never exceed the policy. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const scheduled = this.chain.then(async () => {
      const wait = MIN_INTERVAL_MS - (Date.now() - this.lastCallAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();
      return task();
    });
    // Keep the chain alive even if this task rejects.
    this.chain = scheduled.catch(() => undefined);
    return scheduled;
  }
}

const limiter = new UpstreamLimiter();

/** What a coordinate lookup can tell us about an address. */
export interface ReverseResult {
  label: string;
  city: string | null;
  postcode: string | null;
  /** Picks the shipping zone, so this is the field that decides the fee. */
  state: string | null;
  locality: string | null;
  road: string | null;
}

export class GeocodingProvider {
  /**
   * Geocode a free-text address to coordinates via OpenStreetMap Nominatim.
   * Runs server-side so it isn't blocked by browser CORS (Nominatim sends no
   * Access-Control-Allow-Origin). Returns null on no match / any failure so the
   * caller can fall back to prompting the user to pin their location.
   */
  async geocode(address: string): Promise<{ lat: number; lng: number } | null> {
    const q = (address || "").trim();
    if (!q) return null;
    const key = `g:${q.toLowerCase()}`;
    const cached = limiter.get<{ lat: number; lng: number } | null>(key);
    if (cached.hit) return cached.value;
    return limiter.run(async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: ctrl.signal },
      );
      clearTimeout(timer);
      if (!res.ok) {
        // A 429/5xx is a transient upstream condition, NOT "this address doesn't
        // exist" — caching it would keep returning null long after it clears.
        if (res.status === 429) logger.warn("[Geocode] upstream rate limit (429) — backing off");
        else limiter.set(key, null, true);
        return null;
      }
      const data: any = await res.json();
      const hit = Array.isArray(data) ? data[0] : null;
      const lat = Number(hit?.lat);
      const lng = Number(hit?.lon);
      const out = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      limiter.set(key, out, out === null);
      return out;
    } catch (e) {
      logger.warn(`[Geocode] failed for "${q}": ${(e as Error).message}`);
      return null;
    }
    });
  }

  /**
   * Free-text place search returning up to `limit` labelled candidates, so the
   * storefront can offer real suggestions ("search by address, city or pincode")
   * instead of silently snapping to Nominatim's single best guess. Biased to
   * India, which is the only market the shops operate in.
   * Returns [] on no match / any failure.
   */
  async search(query: string, limit = 6): Promise<Array<{ label: string; lat: number; lng: number }>> {
    const q = (query || "").trim();
    if (q.length < 3) return [];
    const key = `s:${limit}:${q.toLowerCase()}`;
    const cached = limiter.get<Array<{ label: string; lat: number; lng: number }>>(key);
    if (cached.hit) return cached.value;
    return limiter.run(async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=in&limit=${limit}&q=${encodeURIComponent(q)}`,
        { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: ctrl.signal },
      );
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 429) logger.warn("[Geocode] search upstream rate limit (429) — backing off");
        else limiter.set(key, [], true);
        return [];
      }
      const data: any = await res.json();
      if (!Array.isArray(data)) return [];
      const out = data
        .map((hit: any) => ({
          label: String(hit?.display_name ?? "").trim(),
          lat: Number(hit?.lat),
          lng: Number(hit?.lon),
        }))
        .filter((c: any) => c.label && Number.isFinite(c.lat) && Number.isFinite(c.lng));
      limiter.set(key, out, out.length === 0);
      return out;
    } catch (e) {
      logger.warn(`[Geocode] search failed for "${q}": ${(e as Error).message}`);
      return [];
    }
    });
  }

  /**
   * Coordinates → human address, for the "Use current location" flow so the user
   * sees where they actually are instead of a bare lat/lng. Null on failure.
   */
  async reverse(lat: number, lng: number): Promise<ReverseResult | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const key = `r:${lat.toFixed(5)},${lng.toFixed(5)}`;
    const cached = limiter.get<ReverseResult | null>(key);
    if (cached.hit) return cached.value;
    return limiter.run(async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}`,
        { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: ctrl.signal },
      );
      clearTimeout(timer);
      if (!res.ok) { if (res.status !== 429) limiter.set(key, null, true); return null; }
      const data: any = await res.json();
      const label = String(data?.display_name ?? "").trim();
      if (!label) { limiter.set(key, null, true); return null; }
      const a = data?.address ?? {};
      const out: ReverseResult = {
        label,
        city: a.city ?? a.town ?? a.village ?? a.suburb ?? a.county ?? null,
        postcode: a.postcode ?? null,
        // The delivery charge is chosen by state, so "use current location" is
        // only useful if it returns one. Without this the button filled
        // coordinates and left the field that sets the price empty.
        state: a.state ?? a["state_district"] ?? null,
        // Enough to prefill the street line rather than making the customer
        // retype what the lookup already knows.
        locality: a.suburb ?? a.neighbourhood ?? a.village ?? null,
        road: a.road ?? null,
      };
      limiter.set(key, out, false);
      return out;
    } catch (e) {
      logger.warn(`[Geocode] reverse failed for ${lat},${lng}: ${(e as Error).message}`);
      return null;
    }
    });
  }

  async distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): Promise<number> {
    // TODO: replace with Distance Matrix API call
    const R = 6371;
    const toRad = (v: number) => (v * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
}
export const geocodingProvider = new GeocodingProvider();
