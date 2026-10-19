import { Module, forwardRef } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { Brand, Category, Product, ProductMedia, ProductVariant, ShopInventory, StockMovement, ProductPolicy, CategoryPolicy, GlobalPolicy, AuditLog, Deal } from "@/models";
import { CatalogController } from "./catalog.controller";
import { CategoriesService } from './categories.service';
import { StorefrontService } from './storefront.service';
import { ReviewsModule } from "@/modules/reviews/reviews.module";
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { ProductPolicyService } from './product-policy.service';
import { PolicyResolutionService } from '@/modules/returns/policy-resolution.service';

@Module({
  imports: [
    SequelizeModule.forFeature([
      Brand, Category, Product, ProductMedia, ProductVariant, ShopInventory, StockMovement,
      ProductPolicy, CategoryPolicy, GlobalPolicy, AuditLog, Deal
    ]),
    NotificationsModule,
    // Reuses ReviewsService.summaryForProduct for real product ratings.
    forwardRef(() => ReviewsModule)
  ],
  controllers: [CatalogController],
  // CacheService is NOT listed here: it comes from the global AppCacheModule, so
  // the catalog and the inventory module share one cache instance.
  providers: [CategoriesService, ProductPolicyService, PolicyResolutionService, StorefrontService],
})
export class CatalogModule {}
