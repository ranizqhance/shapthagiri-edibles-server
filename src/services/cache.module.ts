import { Global, Module } from "@nestjs/common";
import { CacheService } from "./cache.service";

/**
 * One cache instance for the whole process.
 *
 * `CacheService` was listed in `CatalogModule.providers`, which gives that
 * module its own `NodeCache`. That was invisible while only the catalog wrote
 * to it — but the storefront rails also have to be dropped when inventory
 * changes, and a second instance provided to `InventoryModule` would have
 * cleared a cache nothing reads. Global, so both modules hold the same object.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class AppCacheModule {}
