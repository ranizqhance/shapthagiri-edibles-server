import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { join } from 'path';
import { ServeStaticModule } from '@nestjs/serve-static';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import Redis from "ioredis";
import { env } from "./config/env";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ScheduleModule } from "@nestjs/schedule";

import { DatabaseModule } from "./config/database.module";
import { CorrelationMiddleware } from "./common/middleware/correlation.middleware";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";
import { PermissionsGuard } from "./common/guards/permissions.guard";

import { AuthModule } from "@/modules/auth/auth.module";
import { UsersModule } from "@/modules/users/users.module";
import { CatalogModule } from "@/modules/catalog/catalog.module";
import { ShopsModule } from "@/modules/shops/shops.module";
import { InventoryModule } from "@/modules/inventory/inventory.module";
import { CartModule } from "@/modules/cart/cart.module";
import { WishlistModule } from "@/modules/wishlist/wishlist.module";
import { OrdersModule } from "@/modules/orders/orders.module";
import { DeliveryEngineModule } from "@/modules/delivery-engine/delivery-engine.module";
import { ZoneModule } from "@/modules/delivery-engine/zone.module";
import { PartnersModule } from "@/modules/partners/partners.module";
import { ShipmentsModule } from "@/modules/shipments/shipments.module";
import { PaymentsModule } from "@/modules/payments/payments.module";
import { ReturnsModule } from "@/modules/returns/returns.module";
import { ReviewsModule } from "@/modules/reviews/reviews.module";
import { PromotionsModule } from "@/modules/promotions/promotions.module";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { SearchModule } from "@/modules/search/search.module";
import { SupportModule } from "@/modules/support/support.module";
import { DisputesModule } from "@/modules/disputes/disputes.module";
import { AnalyticsModule } from "@/modules/analytics/analytics.module";
import { FinanceModule } from "@/modules/finance/finance.module";
import { AdminModule } from "@/modules/admin/admin.module";
import { UploadsModule } from "@/modules/uploads/uploads.module";
import { HealthModule } from "@/modules/health/health.module";
import { TrackingModule } from "@/modules/tracking/tracking.gateway";
import { JobsModule } from "@/modules/jobs/jobs.module";
import { WalletModule } from "@/modules/wallet/wallet.module";
import { RbacModule } from "@/modules/rbac/rbac.module";
import { AppCacheModule } from "./services/cache.module";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveRoot: '/public',
    }),
    DatabaseModule,
    AppCacheModule,
    EventEmitterModule.forRoot({ global: true }),
    ScheduleModule.forRoot(),
    /*
     * Rate limiting, in two named tiers plus the per-route overrides.
     *
     * Two things were wrong before. The single tier was 300 requests/minute —
     * generous enough that password guessing and OTP-email flooding ran
     * comfortably underneath it. And there was no `storage`, so counters lived
     * in each process's memory: every replica had its own budget (N replicas
     * meant N× the limit) and every deploy reset them all to zero.
     *
     * Redis-backed when Redis is on, which is how production runs. Falling
     * back to in-memory locally keeps `REDIS_ENABLED=false` development
     * working rather than failing to boot.
     */
    ThrottlerModule.forRoot({
      throttlers: [
        { name: "default", ttl: 60_000, limit: 120 },
        { name: "write", ttl: 60_000, limit: 30 },
      ],
      storage: env.REDIS_ENABLED
        ? new ThrottlerStorageRedisService(
            new Redis({
              host: env.REDIS_HOST,
              port: env.REDIS_PORT,
              ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
              maxRetriesPerRequest: 2,
            }),
          )
        : undefined,
    }),
    AuthModule, UsersModule, CatalogModule, ShopsModule, InventoryModule,
    ZoneModule, CartModule, WishlistModule, OrdersModule, DeliveryEngineModule,
    PartnersModule, ShipmentsModule, PaymentsModule, ReturnsModule, ReviewsModule,
    PromotionsModule, NotificationsModule, SearchModule, SupportModule, DisputesModule,
    AnalyticsModule, FinanceModule, AdminModule, UploadsModule, HealthModule,
    TrackingModule, JobsModule, WalletModule, RbacModule,
  ],
  providers: [
    /*
     * ThrottlerGuard FIRST.
     *
     * APP_GUARDs run in declaration order, and it used to be last — so a
     * request that failed authentication short-circuited at JwtAuthGuard and
     * was never counted. Failed logins, the one thing most worth limiting,
     * were the one thing the limiter never saw.
     */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
