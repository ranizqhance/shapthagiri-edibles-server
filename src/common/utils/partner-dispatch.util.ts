import { Op } from "sequelize";
import { haversineKm } from "./geo.util";

/**
 * Chooses which delivery partner a shipment is offered to.
 *
 * Previously the handover simply took `onlinePartners[0]` from an unordered
 * `findAll`. That contradicted its own comments ("nearest", "most recent ping"),
 * gave an arbitrary partner, ignored zones, and never spread load — so in
 * practice one partner received everything and nobody was picked at all when
 * that partner happened to be offline.
 *
 * Ranking, in order:
 *   1. distance from the partner's last known position to the drop point
 *      (partners with no position sort last rather than being excluded, so a
 *      shipment is still offered when nobody has pinged recently)
 *   2. fewest jobs already taken today — spreads the work
 *   3. highest rating
 *
 * Returns null when there is genuinely nobody available; the caller must treat
 * that as an operational event, not a silent no-op.
 */
export interface PartnerLike {
  id: string;
  userId?: string | null;
  zoneId?: string | null;
  currentLat?: number | null;
  currentLng?: number | null;
  todayJobs?: number | null;
  rating?: number | null;
}

export interface PickOptions {
  /** Drop coordinates for the shipment, when known. */
  dropLat?: number | null;
  dropLng?: number | null;
  /** Partners already offered this shipment (declined/expired) — never re-offer to them. */
  exclude?: string[];
}

/** Rank the candidates and return the best, or null when the list is empty. */
export function pickPartner<T extends PartnerLike>(candidates: T[], opts: PickOptions = {}): T | null {
  const exclude = new Set(opts.exclude ?? []);
  const pool = candidates.filter((p) => !exclude.has(p.id));
  if (!pool.length) return null;

  const hasDrop = opts.dropLat != null && opts.dropLng != null;
  const distance = (p: T): number => {
    if (!hasDrop || p.currentLat == null || p.currentLng == null) return Number.POSITIVE_INFINITY;
    return haversineKm(Number(opts.dropLat), Number(opts.dropLng), Number(p.currentLat), Number(p.currentLng));
  };

  return [...pool].sort((a, b) => {
    const da = distance(a);
    const db = distance(b);
    // Infinity on both sides means neither has a position — fall through to load.
    if (da !== db && Number.isFinite(da + db)) return da - db;
    if (da !== db) return da - db;
    const ja = Number(a.todayJobs ?? 0);
    const jb = Number(b.todayJobs ?? 0);
    if (ja !== jb) return ja - jb;
    return Number(b.rating ?? 0) - Number(a.rating ?? 0);
  })[0];
}

/** The `where` every candidate query shares: online, approved, not already tried. */
export function candidateWhere(exclude: string[] = []) {
  const where: any = { isOnline: true, status: "approved" };
  if (exclude.length) where.id = { [Op.notIn]: exclude };
  return where;
}
