// src/services/cache.service.ts
import NodeCache from "node-cache";
import { Injectable } from "@nestjs/common";
import { Model } from "sequelize";
import { Logger } from "@nestjs/common";
import { env } from "@/config/env";

/**
 * Simple in‑memory cache used for category tree data.
 * In production you would replace this with a distributed cache (Redis, etc.).
 * This version sanitises any value before caching to ensure only plain JSON is stored.
 */
@Injectable()
export class CacheService {
  // 5-minute TTL, and a ceiling: some keys include request input (a shop id),
  // and without one an anonymous caller could mint keys until the heap gave out.
  private cache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 5_000 });
  private readonly logger = new Logger(CacheService.name);
  private warnedNoPurge = false;
  private warnedFullAt = 0;

  /** Sanitize a value before caching: remove Sequelize models, sockets, req/res, etc. */
  private sanitize<T>(value: T): T {
    // Primitive values are safe.
    if (value == null || typeof value !== "object") return value;

    // Arrays – sanitize each element.
    if (Array.isArray(value)) {
      return (value.map((v) => this.sanitize(v)) as unknown) as T;
    }

    // Detect Sequelize model instances (they extend Model and have toJSON).
    if ((value as any) instanceof Model && typeof (value as any).toJSON === "function") {
      return (value as any).toJSON();
    }

    // Plain objects – walk keys and drop known unsafe properties.
    const cleaned: any = {};
    for (const [k, v] of Object.entries(value as any)) {
      if (k === "socket" || k === "req" || k === "res") continue; // drop Node internals
      cleaned[k] = this.sanitize(v as any);
    }
    return cleaned as T;
  }

  set<T>(key: string, value: T, ttlSeconds?: number) {
    const safeValue = this.sanitize(value);
    // A full cache refuses new keys (node-cache throws). Serving the request
    // uncached is the right answer then, not an error.
    try {
      if (ttlSeconds !== undefined) {
        this.cache.set(key, safeValue, ttlSeconds);
      } else {
        this.cache.set(key, safeValue);
      }
    } catch (e) {
      // At most once a minute: a full cache is exactly the state someone
      // filling it on purpose would hold it in, and a line per refused key
      // would turn that into a log flood.
      if (Date.now() - this.warnedFullAt > 60_000) {
        this.warnedFullAt = Date.now();
        this.logger.warn(`cache full (${(e as Error).message}); serving uncached until entries expire`);
      }
    }
  }

  get<T>(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  invalidate(key: string) {
    this.cache.del(key);
  }

  /**
   * Drop `key` and every per-scope variant of it (`key:<scope>`). The category
   * tree is cached once per serving shop, so invalidating only the bare key would
   * leave each shop's copy stale after an admin edit.
   */
  invalidatePrefix(key: string) {
    const doomed = this.cache.keys().filter((k) => k === key || k.startsWith(`${key}:`));
    if (doomed.length) this.cache.del(doomed);
  }

  /**
   * Drop every cached storefront read.
   *
   * Lived as a private method on CatalogController, so only product writes
   * could call it. An inventory change moves a product on and off the
   * storefront just as surely — switching "Active for sale" off is the one
   * control that hides it — and the inventory module had no way to reach this,
   * leaving the rails serving a withdrawn product for up to the five-minute
   * TTL. Category counts are included because they are storefront-scoped too.
   */
  invalidateStorefront() {
    this.invalidatePrefix("storefront:trending");
    this.invalidatePrefix("storefront:deals");
    this.invalidatePrefix("catalog:brands");
    this.invalidatePrefix("categoriesTree");
    void this.purgeWebCache();
  }

  /**
   * Ask the storefront to drop its own cached catalogue reads.
   *
   * Clearing this process's cache is only half the job: Next.js caches the
   * responses for ten minutes on its side, so an item switched off here stayed
   * on the shop page well after the API had stopped serving it.
   *
   * Deliberately fire-and-forget and never thrown from. A storefront that is
   * redeploying must not fail an admin's inventory save; the worst case is the
   * change landing on the existing timer instead of immediately.
   */
  private async purgeWebCache(): Promise<void> {
    const url = env.WEB_REVALIDATE_URL;
    const secret = env.WEB_REVALIDATE_SECRET;
    if (!url || !secret) {
      // Said once, not on every write. Unconfigured, this whole mechanism is a
      // no-op and the storefront falls back to its own timer — which looks
      // exactly like the feature being broken, so it should not be silent.
      if (!this.warnedNoPurge) {
        this.warnedNoPurge = true;
        this.logger.warn(
          "WEB_REVALIDATE_URL/WEB_REVALIDATE_SECRET are not set — the storefront " +
            "will not be told about catalogue changes and will update on its own timer.",
        );
      }
      return;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "x-revalidate-secret": secret },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        this.logger.warn(`Storefront cache purge returned ${res.status}`);
      }
    } catch (e) {
      this.logger.warn(`Storefront cache purge failed: ${(e as Error).message}`);
    }
  }
}
