import { Throttle } from "@nestjs/throttler";
import { LIMITS } from "@/common/security/throttle";
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Ip } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel } from "@nestjs/sequelize";
import { Sequelize, Op, QueryTypes } from "sequelize";
import { Brand, Category, Product, ProductMedia, ProductVariant, ShopInventory, Shop, StockMovement, AuditLog } from "@/models";
import { recordAudit, normalizeIp } from "@/common/utils/audit.util";
import { ConflictException, ForbiddenException, NotFoundException } from "@/common/errors/http";
import { WILDCARD_PERMISSION } from "@/modules/rbac/rbac.catalog";
import { RequirePermissions, RequireAnyPermission } from "@/common/decorators/permissions.decorator";
import { Public } from "@/common/decorators/public.decorator";
import { Role } from "@/common/enums/role.enum";
import { shopScope } from "@/common/utils/permission.util";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate, findOr404, findByIdOrSlugOr404 } from "@/common/utils/crud.util";
import { BrandDto, UpdateBrandDto, CategoryDto, UpdateCategoryDto, CompareDto, MediaDto, ProductDto, VariantDto, SortOrderDto, MoveCategoryDto } from "@/common/dto/common.dto";
import { NotificationsService } from "../notifications/notifications.service";
import { CacheService } from "../../services/cache.service";
import { CategoriesService } from "@/modules/catalog/categories.service";
import { CategoryTreeDto } from "../../common/dto/category-tree.dto";
import { toCategoryTreeDto } from "../../common/utils/mapper";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { ProductPolicyService } from "./product-policy.service";
import { PolicyResolutionService } from "@/modules/returns/policy-resolution.service";
import { ReviewsService } from "@/modules/reviews/reviews.service";
import { StorefrontService } from "./storefront.service";
import { VARIANT_PUBLIC_ATTRS } from "@/common/security/public-attributes";
import {
  availabilityOf,
  sellableInventoryInclude,
  visibleProductClause,
  isValidShopId,
} from "./availability";

/** The shop to name as the seller: cheapest in-stock row, else any row. */
function sellerOf(inventory: ShopInventory[], variants: ProductVariant[]): { id: string; name: string } | null {
  const priced = inventory
    .filter((r) => r.quantity > 0 && (r as any).shop)
    .map((r) => ({ r, p: Number(r.priceOverride ?? variants.find((v) => v.id === r.variantId)?.defaultPrice ?? 0) }))
    .sort((a, b) => a.p - b.p);
  const row = priced[0]?.r ?? inventory.find((r) => (r as any).shop);
  const shop = (row as any)?.shop;
  return shop ? { id: shop.id, name: shop.name } : null;
}

/**
 * Query values that end up inside SQL literals in the listing filters. They
 * were coerced with Number(), so never injectable, but "abc", "Infinity" or
 * "1e999" became NaN/Infinity in the SQL text and the query failed with a 500.
 * Only a finite number turns a filter on.
 */
/** A copy of a plain row without the named keys. */
const omit = <T extends Record<string, any>>(row: T, ...keys: string[]): T => { const out: any = { ...row }; for (const k of keys) delete out[k]; return out; };
const isFiniteNum = (v?: string): boolean => v !== undefined && v !== "" && Number.isFinite(Number(v));
/** A malformed id in a comma list is dropped instead of failing the query. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags("Catalog")
@Controller("catalog")
@RequirePermissions('products.view')
export class CatalogController {
  constructor(
    @InjectModel(Category) private cat: typeof Category,
    @InjectModel(Brand) private brand: typeof Brand,
    @InjectModel(Product) private product: typeof Product,
    @InjectModel(ProductVariant) private variant: typeof ProductVariant,
    @InjectModel(ProductMedia) private media: typeof ProductMedia,
    @InjectModel(ShopInventory) private inv: typeof ShopInventory,
    @InjectModel(StockMovement) private mov: typeof StockMovement,
    @InjectModel(AuditLog) private audit: typeof AuditLog,
    private notifications: NotificationsService,
    private categoriesService: CategoriesService,
    private cacheService: CacheService,
    private eventEmitter: EventEmitter2,
    private productPolicyService: ProductPolicyService,
    private policyResolutionService: PolicyResolutionService,
    private reviews: ReviewsService,
    private storefront: StorefrontService,
  ) {}

  /**
   * Storefront "Trending Products" rail — popularity-ranked (sales, wishlist,
   * reviews, ratings). Independent of any discount or admin curation. Separate
   * query + logic from Deals of the Day (StorefrontService.trending).
   */
  @Public()
  @Get("trending")
  async trending(@Query("shopId") shopId?: string, @Query("limit") limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 8, 1), 24);
    // Every visitor to the home page gets the same rail, and the query behind it
    // runs four correlated subqueries per published product (sales, wishlist
    // count, review count, average rating) just to rank them. Cached per shop
    // and size; dropped whenever a product changes.
    // Only a well-formed shop id reaches the key or the query.
    const shop = shopId && UUID_RE.test(shopId) ? shopId : undefined;
    const key = `storefront:trending:${shop || "all"}:${n}`;
    const cached = this.cacheService.get<{ items: any[] }>(key);
    if (cached) return cached;
    const payload = { items: await this.storefront.trending(shop, n) };
    this.cacheService.set(key, payload);
    return payload;
  }

  /**
   * Storefront "Deals of the Day" rail — only products with an ACTIVE
   * Deal-of-the-Day promotion inside its date window, ordered by admin priority.
   * Separate query + logic from Trending (StorefrontService.deals).
   */
  @Public()
  @Get("deals")
  async deals(@Query("shopId") shopId?: string, @Query("limit") limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 8, 1), 24);
    const shop = shopId && UUID_RE.test(shopId) ? shopId : undefined;
    const key = `storefront:deals:${shop || "all"}:${n}`;
    const cached = this.cacheService.get<{ items: any[] }>(key);
    if (cached) return cached;
    const payload = { items: await this.storefront.deals(shop, n) };
    this.cacheService.set(key, payload);
    return payload;
  }

  @Public()
  @Get('categories')
  async getCategories(
    @Query('q') q?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('shopId') shopId?: string,
  ) {
    // Only a well-formed UUID is passed through — it is interpolated into the
    // productCount subquery downstream.
    const servingShopId =
      shopId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopId)
        ? shopId
        : undefined;

    if (q || page || limit) {
      const models = await this.categoriesService.findTree(q, page, limit, servingShopId);
      return models.map(toCategoryTreeDto);
    }
    // Cache per serving shop. A single global 'categoriesTree' key would have
    // served one shop's counts to every other shop (and to anonymous visitors).
    const cacheKey = servingShopId ? `categoriesTree:${servingShopId}` : 'categoriesTree';
    const cached = this.cacheService.get<CategoryTreeDto[]>(cacheKey);
    if (cached) return cached;
    const models = await this.categoriesService.findTree(undefined, undefined, undefined, servingShopId);
    const dtos = models.map(toCategoryTreeDto);
    this.cacheService.set(cacheKey, dtos);
    return dtos;
  }

  @ApiBearerAuth()
  @RequirePermissions('categories.create')
  @Post('categories')
  async createCategory(@Body() b: CategoryDto) {
    const cat = await this.categoriesService.create(b as any);
    // invalidate cache
    this.cacheService.invalidatePrefix('categoriesTree');
    return cat;
  }

  @ApiBearerAuth()
  @RequirePermissions('categories.edit')
  @Patch('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() b: UpdateCategoryDto) {
    const cat = await this.categoriesService.update(id, b as any);
    this.cacheService.invalidatePrefix('categoriesTree');
    return cat;
  }

  @ApiBearerAuth()
  @RequirePermissions('categories.delete')
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string, @Query('reassign') reassign?: string) {
    const result = await this.categoriesService.delete(id, reassign);
    this.cacheService.invalidatePrefix('categoriesTree');
    return result;
  }

  @Public()
  @Get('categories/:id')
  async getCategoryById(@Param('id') id: string) {
    return await findOr404<Category>(this.cat, id, "Category");
  }

  // ---------------------------------------------------------------------
  // Category hierarchy helpers
  // ---------------------------------------------------------------------
  @Public()
  @Get('categories/:id/children')
  async getCategoryChildren(@Param('id') id: string) {
    const children = await this.cat.findAll({ where: { parentId: id } });
    return children;
  }

  @ApiBearerAuth()
  @RequirePermissions('categories.edit')
  @Patch('categories/:id/move')
  async moveCategory(@Param('id') id: string, @Body() b: MoveCategoryDto) {
    const cat = await this.categoriesService.move(id, b.parentId ?? null);
    this.cacheService.invalidatePrefix('categoriesTree');
    return cat;
  }

  @Throttle(LIMITS.search)
  @ApiBearerAuth()
  @RequirePermissions()
  @RequireAnyPermission('products.manageVariants', 'products.view', 'coupons.view', 'marketing.view', 'inventory.view')
  @Get("variants/search")
  async searchVariants(@Query() opts: PageOptionsDto) {
    const where: any = {};
    const andConditions: any[] = [];
    const productIncludes = [
      { model: this.brand, as: "brand", attributes: ["name"] },
      { model: this.cat, as: "category", attributes: ["name"] },
      // `separate: true` is required for per-include order/limit to mean
      // anything on a hasMany: without it Sequelize builds one JOIN and the
      // limit applies to the whole result set, unordered. That is how a
      // product whose primary image is sortOrder 0 could show its second
      // photo on the card.
      { model: this.media, as: "media", separate: true, order: [["sortOrder", "ASC"], ["createdAt", "ASC"]], limit: 1 },
    ];

    if (opts.q) {
      andConditions.push({
        [Op.or]: [
          { sku: { [Op.iLike]: `%${opts.q}%` } },
          { "$product.title$": { [Op.iLike]: `%${opts.q}%` } },
        ]
      });
    }

    if ((opts as any).ids) {
      const idsArr = (opts as any).ids.split(",");
      andConditions.push({ id: { [Op.in]: idsArr } });
    }

    if (andConditions.length > 0) {
      where[Op.and] = andConditions;
    }

    const includes = [
      { 
        model: this.product,
        as: "product",
        include: productIncludes,
        required: true,
      },
      {
        model: this.inv,
        as: "inventory",
        include: [{ model: Shop, as: "shop", attributes: ["name", "isActive"] }]
      }
    ];

    return paginate(this.variant, opts, where, includes, { subQuery: false });
  }

  // An unbounded findAll that almost never changes.
  /**
   * Drop the cached storefront rails.
   *
   * Trending and Deals are derived from products, so any product mutation can
   * change them. Called from every product write rather than relying on the
   * TTL, so an admin sees their edit on the storefront immediately.
   */
  private invalidateStorefrontCaches() {
    this.cacheService.invalidateStorefront();
  }

  @Public() @Get("brands") async brands() {
    const cached = this.cacheService.get<any[]>("catalog:brands");
    if (cached) return cached;
    const rows = await this.brand.findAll();
    this.cacheService.set("catalog:brands", rows);
    return rows;
  }
  @ApiBearerAuth() @RequirePermissions('brands.create') @Post("brands") async createBrand(@CurrentUser() u: JwtPayload, @Ip() ip: string, @Body() b: BrandDto) {
    const created = await this.brand.create(b as any);
    await recordAudit(this.audit, { actorId: u?.sub, action: "brand_created", entity: "Brand", entityId: created.id, after: { name: created.name }, ip: normalizeIp(ip) });
    this.invalidateStorefrontCaches();
    return created;
  }

  @ApiBearerAuth() @RequirePermissions('brands.edit') @Patch("brands/:id") async updateBrand(@CurrentUser() u: JwtPayload, @Ip() ip: string, @Param("id") id: string, @Body() b: UpdateBrandDto) {
    const brand = await findOr404<Brand>(this.brand, id, "Brand");
    const before = { name: brand.name, slug: brand.slug, logoUrl: brand.logoUrl };
    await brand.update(b as any);
    await recordAudit(this.audit, { actorId: u?.sub, action: "brand_updated", entity: "Brand", entityId: id, before, after: b, ip: normalizeIp(ip) });
    this.invalidateStorefrontCaches();
    return brand;
  }

  /** Refused while products still carry the brand — move them first. */
  @ApiBearerAuth() @RequirePermissions('brands.delete') @Delete("brands/:id") async deleteBrand(@CurrentUser() u: JwtPayload, @Ip() ip: string, @Param("id") id: string) {
    const brand = await findOr404<Brand>(this.brand, id, "Brand");
    const inUse = await this.product.count({ where: { brandId: id } });
    if (inUse) throw new ConflictException(undefined, `${brand.name} is on ${inUse} product${inUse === 1 ? "" : "s"} — move ${inUse === 1 ? "it" : "them"} to another brand first.`);
    await brand.destroy();
    await recordAudit(this.audit, { actorId: u?.sub, action: "brand_deleted", entity: "Brand", entityId: id, before: { name: brand.name }, ip: normalizeIp(ip) });
    this.invalidateStorefrontCaches();
    return { deleted: true };
  }

  @Public() @Get("products") async products(
    @Query() opts: PageOptionsDto,
    @Query("categoryId") categoryId?: string,
    @Query("brandId") brandId?: string,
    @Query("maxPrice") maxPrice?: string,
    @Query("minRating") minRating?: string,
    @Query("inStockOnly") inStockOnly?: string,
    @Query("minDiscount") minDiscount?: string,
    @Query("shopId") shopId?: string,
  ) {
    const validShopId = !!shopId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopId);
    const where: any = { status: "published" };
    // Single-serving-shop: return ONLY the serving shop's inventory rows so the
    // mapped price/stock reflect that shop (not a global min/sum across all shops).
    // Columns the listing mapper actually reads (see lib/mapProduct.ts on the
    // web side): inventory for the min price and the stock total, media for the
    // card image, and the variant's own price fields. Without these lists
    // Sequelize selects every column of every row at every level, so a grid of
    // 20 cards carried each product's `specifications` JSONB and every
    // inventory row in full.
    // Sellable rows only: active, at a shop that still exists and is active.
    // An unqualified include summed rows belonging to deleted shops, which is
    // how a card came to show 200 units where the admin screen showed 50.
    const invInclude: any = sellableInventoryInclude(validShopId ? shopId : undefined);
    const includes: any[] = [
      {
        model: this.variant,
        attributes: ["id", "productId", "sku", "defaultPrice", "mrp", "attributes"],
        include: [invInclude],
      },
      // Ordered so media[0] is always the image the admin marked Primary.
      // Postgres returns rows in no guaranteed order otherwise, and the
      // frontend takes the first one.
      {
        model: this.media,
        attributes: ["id", "productId", "variantId", "url", "type", "sortOrder"],
        separate: true,
        order: [["sortOrder", "ASC"], ["createdAt", "ASC"]],
      },
      // The product's own brand (Pooram, Sun Classic, …) for the card's brand line.
      { model: this.brand, attributes: ["id", "name"] },
    ];
    // The storefront visibility gate. A product with no active inventory row
    // anywhere is off the shop floor entirely — that is what the Inventory
    // screen's "Active for sale" toggle means. Stock level is NOT part of it:
    // selling out leaves the product listed and marked out of stock.
    const andConditions: any[] = [visibleProductClause(validShopId ? shopId : undefined)];

    // Scope the catalog to a single shop: only products with active, in-stock
    // inventory at that shop. Backs the storefront "nearest shop" listing.
    // shopId is validated as a UUID so it is safe to interpolate.
    if (validShopId) {
      andConditions.push(
        Sequelize.literal(
          `EXISTS (SELECT 1 FROM "shop_inventory" INNER JOIN "product_variants" ON "product_variants"."id" = "shop_inventory"."variantId" WHERE "product_variants"."productId" = "Product"."id" AND "shop_inventory"."shopId" = '${shopId}' AND "shop_inventory"."isActive" = true AND "shop_inventory"."quantity" > 0)`
        )
      );
    }

    if (opts.q) {
      includes.push({ model: this.brand, as: "brand", attributes: ["name"] });
      includes.push({ model: this.cat, as: "category", attributes: ["name"] });
      andConditions.push({
        [Op.or]: [
          { title: { [Op.iLike]: `%${opts.q}%` } },
          { subtitle: { [Op.iLike]: `%${opts.q}%` } },
          { description: { [Op.iLike]: `%${opts.q}%` } },
          { "$brand.name$": { [Op.iLike]: `%${opts.q}%` } },
          { "$category.name$": { [Op.iLike]: `%${opts.q}%` } },
          // SKU search — partial, case-insensitive, across the product's variants.
          { "$variants.sku$": { [Op.iLike]: `%${opts.q}%` } },
        ]
      });
    }

    if (categoryId === "none") {
      // Every category unticked in the filter. That is a real choice,
      // distinct from "no category filter", and it means nothing matches.
      // Handled before the split because "none" is not a uuid — comparing it
      // to the column would make Postgres throw instead of returning a page.
      andConditions.push(Sequelize.literal("1 = 0"));
    } else if (categoryId) {
      // Match products DIRECTLY assigned to the given category only — do not
      // roll up descendant categories. A product assigned to a sub-category such as
      // "Roasted Coconut Oil" appears under "Roasted Coconut Oil", never under its parent "Coconut Oil".
      const categoryIdList = categoryId.split(',').map(s => s.trim()).filter((s) => UUID_RE.test(s));
      where.categoryId = { [Op.in]: categoryIdList };
    }
    if (brandId) where.brandId = brandId;

    if (isFiniteNum(maxPrice)) {
      andConditions.push(
        Sequelize.literal(
          `EXISTS (SELECT 1 FROM "product_variants" WHERE "product_variants"."productId" = "Product"."id" AND "product_variants"."defaultPrice" <= ${Number(maxPrice)})`
        )
      );
    }

    if (inStockOnly === "true") {
      andConditions.push(
        Sequelize.literal(
          // Table is "shop_inventory" (singular) — the old "shop_inventories"
          // name does not exist and made this filter throw.
          `EXISTS (SELECT 1 FROM "product_variants" INNER JOIN "shop_inventory" ON "shop_inventory"."variantId" = "product_variants"."id" INNER JOIN "shops" ON "shops"."id" = "shop_inventory"."shopId" WHERE "product_variants"."productId" = "Product"."id" AND "shop_inventory"."isActive" = true AND "shop_inventory"."quantity" > 0 AND "shops"."isActive" = true)`
        )
      );
    }

    if (isFiniteNum(minDiscount)) {
      andConditions.push(
        Sequelize.literal(
          `EXISTS (SELECT 1 FROM "product_variants" WHERE "product_variants"."productId" = "Product"."id" AND "product_variants"."mrp" > 0 AND (("product_variants"."mrp" - "product_variants"."defaultPrice") / "product_variants"."mrp" * 100) >= ${Number(minDiscount)})`
        )
      );
    }

    if (isFiniteNum(minRating)) {
      andConditions.push(
        Sequelize.literal(
          // Was COALESCE(..., 4.0): every unreviewed product silently satisfied
          // "4 stars & above". Unrated products now score 0 and are excluded.
          `(SELECT COALESCE(AVG("rating"), 0) FROM "product_reviews" WHERE "product_reviews"."status" = 'approved' AND "product_reviews"."deletedAt" IS NULL AND "product_reviews"."variantId" IN (SELECT "id" FROM "product_variants" WHERE "product_variants"."productId" = "Product"."id")) >= ${Number(minRating)}`
        )
      );
    }

    if (andConditions.length > 0) {
      where[Op.and] = andConditions;
    }

    // subQuery:false is ONLY safe/needed when the WHERE references a JOINED
    // include column — i.e. the `q` search ($variants.sku$ / $brand.name$ /
    // $category.name$), which can't live in an inner subquery. Every other
    // filter (shopId, price, stock, discount, rating) uses an EXISTS subquery on
    // "Product"."id", which works with the default subQuery:true. Forcing
    // subQuery:false for those made LIMIT apply to the flattened variant×inventory×media
    // join instead of to distinct products, so one product's fan-out could eat the
    // whole page (e.g. Al Ameen: 4 products, only 1 rendered). Let it default.
    const needsSubQueryFalse = !!opts.q;
    const extra: any = needsSubQueryFalse ? { subQuery: false } : {};

    // Rank search results by WHERE the term matched.
    //
    // Descriptions carry usage notes, so a match there is far weaker than a
    // match in the name: searching "hair oil" would otherwise rank a cooking
    // oil whose description mentions hair care alongside the actual hair oils.
    // Title first, then subtitle, then everything the OR above allows.
    if (opts.q && (!opts.sortBy || opts.sortBy === "relevance")) {
      const esc = (v: string) => (this.product as any).sequelize.escape(v);
      const starts = esc(`${opts.q}%`);
      const anywhere = esc(`%${opts.q}%`);
      extra.order = [
        [
          Sequelize.literal(
            `CASE
               WHEN "Product"."title" ILIKE ${starts} THEN 0
               WHEN "Product"."title" ILIKE ${anywhere} THEN 1
               WHEN "Product"."subtitle" ILIKE ${anywhere} THEN 2
               ELSE 3
             END`
          ),
          "ASC",
        ],
        ["createdAt", "DESC"],
      ];
    }

    // The root columns a card needs. `specifications` (JSONB) in particular was
    // being sent for every product in the grid and is read by nothing on the
    // listing — the detail endpoint returns it where it is actually used.
    // `description` stays: the large card prints its first sentence.
    extra.attributes = [
      "id", "title", "subtitle", "description", "slug",
      "categoryId", "brandId", "status", "createdAt",
    ];

    const page = await paginate<any>(this.product, opts, where, includes, extra);
    // The card renders `availability`, never a raw quantity. Computed here so
    // the storefront never has to sum inventory rows for itself and arrive at a
    // different answer from the product page.
    return {
      ...page,
      items: page.items.map((row: any) => {
        const json = row.toJSON ? row.toJSON() : row;
        return { ...json, availability: availabilityOf(json.variants) };
      }),
    };
  }

  @ApiBearerAuth() @RequirePermissions('products.view') @Get("admin/products") async adminProducts(
    @Query() opts: PageOptionsDto, 
    @Query("categoryId") categoryId?: string, 
    @Query("brandId") brandId?: string,
    @Query("status") status?: string,
    @Query("maxPrice") maxPrice?: string,
    @Query("minRating") minRating?: string,
    @Query("inStockOnly") inStockOnly?: string,
    @Query("minDiscount") minDiscount?: string,
  ) {
    const where: any = {};
    if (status) where.status = status;
    const includes: any[] = [
      { model: this.variant, include: [this.inv] },
      // Ordered so media[0] is the image marked Primary. The admin product
      // grid takes the first entry as the cover, and without an ORDER BY
      // Postgres returns the rows arbitrarily — so a product could show its
      // second photo in the dashboard while the edit screen showed the first
      // as Primary.
      { model: this.media, separate: true, order: [["sortOrder", "ASC"], ["createdAt", "ASC"]] },
    ];
    const andConditions: any[] = [];

    if (opts.q) {
      includes.push({ model: this.brand, as: "brand", attributes: ["name"] });
      includes.push({ model: this.cat, as: "category", attributes: ["name"] });
      andConditions.push({
        [Op.or]: [
          { title: { [Op.iLike]: `%${opts.q}%` } },
          { subtitle: { [Op.iLike]: `%${opts.q}%` } },
          { description: { [Op.iLike]: `%${opts.q}%` } },
          { "$brand.name$": { [Op.iLike]: `%${opts.q}%` } },
          { "$category.name$": { [Op.iLike]: `%${opts.q}%` } },
          // SKU search — partial, case-insensitive, across the product's variants.
          { "$variants.sku$": { [Op.iLike]: `%${opts.q}%` } },
        ]
      });
    }

    if (categoryId) {
      // Match products DIRECTLY assigned to the given category only — do not
      // roll up descendant categories. A product assigned to a sub-category such as
      // "Roasted Coconut Oil" appears under "Roasted Coconut Oil", never under its parent "Coconut Oil".
      const categoryIdList = categoryId.split(',').map(s => s.trim()).filter((s) => UUID_RE.test(s));
      where.categoryId = { [Op.in]: categoryIdList };
    }
    if (brandId) where.brandId = brandId;

    if (isFiniteNum(maxPrice)) {
      andConditions.push(
        Sequelize.literal(
          `EXISTS (SELECT 1 FROM "product_variants" WHERE "product_variants"."productId" = "Product"."id" AND "product_variants"."defaultPrice" <= ${Number(maxPrice)})`
        )
      );
    }

    if (inStockOnly === "true") {
      andConditions.push(
        Sequelize.literal(
          // Table is "shop_inventory" (singular) — the old "shop_inventories"
          // name does not exist and made this filter throw.
          `EXISTS (SELECT 1 FROM "product_variants" INNER JOIN "shop_inventory" ON "shop_inventory"."variantId" = "product_variants"."id" INNER JOIN "shops" ON "shops"."id" = "shop_inventory"."shopId" WHERE "product_variants"."productId" = "Product"."id" AND "shop_inventory"."isActive" = true AND "shop_inventory"."quantity" > 0 AND "shops"."isActive" = true)`
        )
      );
    }

    if (isFiniteNum(minDiscount)) {
      andConditions.push(
        Sequelize.literal(
          `EXISTS (SELECT 1 FROM "product_variants" WHERE "product_variants"."productId" = "Product"."id" AND "product_variants"."mrp" > 0 AND (("product_variants"."mrp" - "product_variants"."defaultPrice") / "product_variants"."mrp" * 100) >= ${Number(minDiscount)})`
        )
      );
    }

    if (isFiniteNum(minRating)) {
      andConditions.push(
        Sequelize.literal(
          // Was COALESCE(..., 4.0): every unreviewed product silently satisfied
          // "4 stars & above". Unrated products now score 0 and are excluded.
          `(SELECT COALESCE(AVG("rating"), 0) FROM "product_reviews" WHERE "product_reviews"."status" = 'approved' AND "product_reviews"."deletedAt" IS NULL AND "product_reviews"."variantId" IN (SELECT "id" FROM "product_variants" WHERE "product_variants"."productId" = "Product"."id")) >= ${Number(minRating)}`
        )
      );
    }

    if (andConditions.length > 0) {
      where[Op.and] = andConditions;
    }

    const needsSubQueryFalse = opts.q || maxPrice || inStockOnly || minDiscount || minRating;
    return paginate(this.product, opts, where, includes, needsSubQueryFalse ? { subQuery: false } : {});
  }

  @Public() @Get("products/:id") async productDetail(@Param("id") id: string, @Query("shopId") shopId?: string) {
    const product = await findByIdOrSlugOr404<Product>(this.product, id, "Product");
    const brand = product.brandId ? await this.brand.findByPk(product.brandId, { attributes: ["id", "name"] }) : null;
    const variants = await this.variant.findAll({ where: { productId: product.id }, attributes: VARIANT_PUBLIC_ATTRS });
    const media = await this.media.findAll({
      where: { productId: product.id },
      // Primary first, so the gallery opens on the image the admin chose.
      order: [["sortOrder", "ASC"], ["createdAt", "ASC"]],
    });
    const validShopId = !!shopId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopId);
    // Single-serving-shop: scope price/stock/variants to the serving shop only.
    // A product with no active inventory at that shop returns empty inventory →
    // totalStock 0 / bestPrice null → the storefront renders it as Out of Stock.
    const invWhere: any = { variantId: variants.map((v) => v.id), isActive: true };
    if (validShopId) invWhere.shopId = shopId;
    const inventory = await this.inv.findAll({
      where: invWhere,
      include: [{
        model: Shop,
        as: "shop",
        // Public endpoint: the shop's name and town only — never its contact
        // details, manager or delivery settings.
        attributes: ["id", "name", "city", "state"],
        where: { isActive: true },
        required: true,
      }],
    });

    /*
     * The visibility gate, applied by id AND by slug.
     *
     * This endpoint used to resolve anything: a draft, an archived product, or
     * one whose every inventory row had been switched off on the Inventory
     * screen. It was reachable directly and through "similar products", so
     * turning an item off never actually took it off the site.
     *
     * Deliberately asks "sellable at ANY shop", not at the serving shop. A shop
     * that simply does not carry the item still renders the page as out of
     * stock, which is the behaviour the single-shop scoping below was written
     * for; only switching it off everywhere makes the URL disappear.
     */
    const sellableAnywhere = await this.inv.count({
      where: { variantId: variants.map((v) => v.id), isActive: true },
      include: [{ model: Shop, as: "shop", attributes: [], required: true, where: { isActive: true } }],
    });
    if (product.status !== "published" || sellableAnywhere === 0) {
      throw new NotFoundException("NOT_FOUND", "Product not found");
    }

    const totalStock = inventory.reduce((s, r) => s + r.quantity, 0);
    const bestPrice = inventory.reduce((min: number | null, r) => {
      const p = Number(r.priceOverride ?? variants.find((v) => v.id === r.variantId)?.defaultPrice ?? 0);
      return min === null || p < min ? p : min;
    }, null);

    const variantsWithInv = variants.map(v => {
      const vPlain = v.get({ plain: true });
      vPlain.inventory = inventory.filter(i => i.variantId === v.id);
      return vPlain;
    });

    const policy = await this.policyResolutionService.resolvePolicy(product.id, product.categoryId || undefined);

    // Real rating from approved reviews. The product page renders
    // Math.round(product.rating) but no rating field was ever returned, so it
    // always rendered 0 stars. Reuses ReviewsService — no duplicated aggregation.
    const ratingSummary = await this.reviews.summaryForProduct(product.id);

    // Real units sold: delivered/completed order-item quantity MINUS refunded
    // return quantity. Excludes pending/cancelled/failed shipments (only
    // delivered+completed count) and nets out refunded units. No dummy/hash value.
    const soldRows = await this.product.sequelize!.query<{ sold: string }>(
      `SELECT GREATEST(
         COALESCE((
           SELECT SUM(oi.quantity) FROM order_items oi
           JOIN order_shipments os ON oi."shipmentId" = os.id
           WHERE oi."productId" = :pid AND os.status IN ('delivered','completed')
         ), 0)
         - COALESCE((
           SELECT SUM(r.quantity) FROM returns r
           JOIN order_items oi2 ON r."orderItemId" = oi2.id
           WHERE oi2."productId" = :pid AND r.status = 'refunded'
         ), 0)
       , 0) AS sold`,
      { replacements: { pid: product.id }, type: QueryTypes.SELECT },
    );
    const soldCount = Number(soldRows?.[0]?.sold ?? 0);

    return {
      // Not `submittedBy`: which staff account created a product is not shoppers' business.
      product: { ...omit(product.toJSON(), "submittedBy"), brand: brand?.toJSON() ?? null, rating: ratingSummary.average, reviewCount: ratingSummary.count, soldCount },
      variants: variantsWithInv,
      media,
      totalStock,
      // What the page actually renders. `unitsLeft` is null unless stock is at
      // or below the configured threshold, so the exact count only reaches the
      // browser when it is meant to be shown.
      availability: availabilityOf(variantsWithInv),
      bestPrice,
      soldCount,
      policy,
      ratingSummary,
      // Tells the storefront the price/stock above are scoped to the serving shop.
      shopScoped: validShopId,
      shopId: validShopId ? shopId : null,
      // Who sells it: the serving shop when scoped, else the shop with the best
      // in-stock price. Buy Now carries this into checkout's summary.
      shop: sellerOf(inventory, variants),
    };
  }

  // Shop managers may submit products (created as draft); an admin approves them.
  @ApiBearerAuth() @RequirePermissions('products.create') @Post("products") async createProduct(@CurrentUser() u: JwtPayload, @Ip() ip: string, @Body() b: ProductDto) {
    this.invalidateStorefrontCaches();
    const { shopId, shopIds, sku, defaultPrice, mrp, policy, _hasCombinations, baseStock, ...productData } = b as any;
    const product = await this.product.create({ ...productData, status: "draft", submittedBy: u.sub } as any);
    await recordAudit(this.audit, {
      actorId: u.sub, action: "product_created", entity: "Product", entityId: product.id,
      after: { title: product.title, status: product.status }, ip: normalizeIp(ip),
    });

    if (policy) {
      await this.productPolicyService.upsertPolicy(product.id, policy);
    }

    // Create variant if sku or defaultPrice is provided and no combinations
    if (!_hasCombinations && (sku || defaultPrice !== undefined)) {
      const variant = await this.variant.create({
        sku: sku || `SKU-${Date.now().toString().slice(-6)}`,
        defaultPrice: defaultPrice ?? 0,
        mrp: mrp ?? defaultPrice ?? 0,
        productId: product.id,
      } as any);

      // Resolve shop IDs — prefer the multi-select array, fall back to single shopId.
      // A shop account stocks its own shop only, whatever the form sent.
      const scope = shopScope(u);
      const allShopIds = scope ? [scope] : shopIds?.length ? shopIds : shopId ? [shopId] : [];
      for (const sid of allShopIds) {
        // Base stock → quantity; base price → priceOverride (per-shop selling
        // price). Reuses the same ShopInventory row the inventory module manages.
        await this.inv.findOrCreate({
          where: { shopId: sid, variantId: variant.id },
          defaults: {
            shopId: sid,
            variantId: variant.id,
            quantity: baseStock ?? 0,
            priceOverride: defaultPrice ?? null,
            isActive: true,
          } as any,
        });
      }
    }

    // A manager submission needs admin review — alert the admins.
    if (u.role === Role.SHOP_MANAGER) {
      await this.notifications.notifyRole(Role.ADMIN, "Product pending approval", `"${product.title}" was submitted for review.`);
    } else {
      this.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.PRODUCT_CREATED,
        variables: { productId: product.id, title: product.title }
      });
    }
    return product;
  }
  @ApiBearerAuth() @RequirePermissions('products.approve') @Post("products/:id/approve") async approve(@CurrentUser() u: JwtPayload, @Ip() ip: string, @Param("id") id: string) {
    this.invalidateStorefrontCaches();
    const before = await this.product.findByPk(id);
    await this.product.update({ status: "published" }, { where: { id } });
    await recordAudit(this.audit, {
      actorId: u.sub, action: "product_approved", entity: "Product", entityId: id,
      before: { status: before?.status }, after: { status: "published" }, ip: normalizeIp(ip),
    });
    return { published: true };
  }
  @ApiBearerAuth() @RequirePermissions('products.edit') @Patch("products/:id") async patch(@CurrentUser() u: JwtPayload, @Ip() ip: string, @Param("id") id: string, @Body() b: ProductDto) {
    this.invalidateStorefrontCaches();
    const { shopId, shopIds, sku, defaultPrice, mrp, policy, _hasCombinations, baseStock, ...productData } = b as any;
    const before = await this.product.findByPk(id);
    // Going live is an approval step: editors without approve/publish rights cannot flip a product to published.
    if (productData.status === "published" && before?.status !== "published") {
      const held = (u as any).permissions ?? [];
      if (!["products.approve", "products.publish", WILDCARD_PERMISSION].some((k) => held.includes(k))) {
        throw new ForbiddenException("FORBIDDEN", "Publishing a product needs approval");
      }
    }
    await this.product.update(productData, { where: { id } });
    await recordAudit(this.audit, {
      actorId: u.sub, action: "product_updated", entity: "Product", entityId: id,
      before: before ? { title: before.title, status: before.status } : null,
      after: { ...(productData.title !== undefined ? { title: productData.title } : {}), ...(productData.status !== undefined ? { status: productData.status } : {}) },
      ip: normalizeIp(ip),
    });

    if (policy) {
      await this.productPolicyService.upsertPolicy(id, policy);
    }

    // Update variant and shop if price, mrp, sku, or any shop field is provided and no combinations exist
    if (!_hasCombinations && (defaultPrice !== undefined || mrp !== undefined || sku || shopId !== undefined || shopIds !== undefined)) {
      const [variant, created] = await this.variant.findOrCreate({
        where: { productId: id },
        defaults: {
          sku: sku || `SKU-${Date.now().toString().slice(-6)}`,
          defaultPrice: defaultPrice ?? 0,
          mrp: mrp ?? defaultPrice ?? 0,
          productId: id,
        } as any
      });

      if (!created) {
        const updateData: any = {};
        if (sku) updateData.sku = sku;
        if (defaultPrice !== undefined) updateData.defaultPrice = defaultPrice;
        if (mrp !== undefined) updateData.mrp = mrp;
        await variant.update(updateData);
      }

      // Resolve desired shop set from the multi-select array or single shopId.
      // A shop account only ever touches its own shop's row: the "remove shops
      // no longer selected" step below used to delete OTHER shops' inventory
      // when a manager saved the form.
      const scope = shopScope(u);
      const cleared = (shopIds !== undefined && !shopIds?.length) || shopId === null || shopId === "";
      const mentioned = shopIds !== undefined || shopId !== undefined;
      const desiredShopIds: string[] = scope
        ? (mentioned && !cleared ? [scope] : [])
        : shopIds?.length ? shopIds : shopId ? [shopId] : [];
      // Only touch stock/price when explicitly provided, so a plain title edit
      // does not zero existing inventory.
      const invUpdate: any = {};
      if (baseStock !== undefined) invUpdate.quantity = baseStock;
      if (defaultPrice !== undefined) invUpdate.priceOverride = defaultPrice;
      if (desiredShopIds.length > 0) {
        // Remove shops no longer in the desired set (platform staff only).
        if (!scope) await this.inv.destroy({ where: { variantId: variant.id, shopId: { [Op.notIn]: desiredShopIds } } });
        // Ensure each desired shop has an inventory row, carrying base stock/price
        for (const sid of desiredShopIds) {
          const [invRow, invCreated] = await this.inv.findOrCreate({
            where: { shopId: sid, variantId: variant.id },
            defaults: {
              shopId: sid,
              variantId: variant.id,
              quantity: baseStock ?? 0,
              priceOverride: defaultPrice ?? null,
              isActive: true,
            } as any,
          });
          if (!invCreated && Object.keys(invUpdate).length > 0) {
            await invRow.update(invUpdate);
          }
        }
      } else if (shopIds !== undefined || shopId === null || shopId === "") {
        // Explicitly cleared — remove the shop associations this caller owns.
        await this.inv.destroy({ where: { variantId: variant.id, ...(scope ? { shopId: scope } : {}) } });
      }
    }

    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.PRODUCT_UPDATED,
      variables: { productId: id, title: b.title || "Product" }
    });

    return this.product.findByPk(id);
  }
  @ApiBearerAuth() @RequirePermissions('products.delete') @Delete("products/:id") async del(@CurrentUser() u: JwtPayload, @Ip() ip: string, @Param("id") id: string) {
    this.invalidateStorefrontCaches();
    const sequelize = this.product.sequelize;
    if (!sequelize) {
      throw new Error("Sequelize instance not available on model");
    }
    const before = await this.product.findByPk(id);
    // Deleting a product removes it from every shop. A shop account may do that
    // only to a product no other shop stocks.
    const scope = shopScope(u);
    if (scope) {
      const elsewhere = await this.inv.count({
        where: { shopId: { [Op.ne]: scope } },
        include: [{ model: this.variant, as: "variant", attributes: [], required: true, where: { productId: id } }],
      });
      if (elsewhere > 0) throw new ForbiddenException("AUTH_FORBIDDEN", "Another shop stocks this product, so only an administrator can delete it.");
    }
    await sequelize.transaction(async (t) => {
      const variants = await this.variant.findAll({ where: { productId: id }, transaction: t });
      const variantIds = variants.map(v => v.id);

      if (variantIds.length > 0) {
        const inventories = await this.inv.findAll({
          where: { variantId: { [Op.in]: variantIds }, quantity: { [Op.gt]: 0 } },
          transaction: t
        });

        for (const invItem of inventories) {
          await this.mov.create({
            shopId: invItem.shopId,
            variantId: invItem.variantId,
            type: "PRODUCT_DELETION",
            quantity: invItem.quantity,
            reason: "Product soft deleted",
            referenceType: "PRODUCT",
            referenceId: id,
          } as any, { transaction: t });
        }

        await this.inv.update(
          { isActive: false, quantity: 0 },
          { where: { variantId: { [Op.in]: variantIds } }, transaction: t }
        );
        await this.variant.destroy({ where: { productId: id }, transaction: t });
      }

      await this.media.destroy({ where: { productId: id }, transaction: t });
      await this.product.destroy({ where: { id }, transaction: t });
    });

    await recordAudit(this.audit, {
      actorId: u.sub, action: "product_deleted", entity: "Product", entityId: id,
      before: before ? { title: before.title, status: before.status } : null, ip: normalizeIp(ip),
    });

    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.PRODUCT_DELETED,
      variables: { productId: id }
    });

    return { deleted: true };
  }

  @ApiBearerAuth() @RequirePermissions('products.manageVariants') @Post("products/:id/variants") createVariant(@Param("id") id: string, @Body() b: VariantDto) {
    return this.variant.create({ ...b, productId: id } as any);
  }

  @ApiBearerAuth() @RequirePermissions('products.manageVariants') @Patch("products/:id/variants/:variantId")
  async updateVariant(@Param("id") id: string, @Param("variantId") variantId: string, @Body() b: VariantDto) {
    await this.variant.update(b as any, { where: { id: variantId, productId: id } });
    return this.variant.findOne({ where: { id: variantId, productId: id } });
  }

  @ApiBearerAuth() @RequirePermissions('products.manageVariants') @Delete("products/:id/variants/:variantId")
  async deleteVariant(@Param("id") id: string, @Param("variantId") variantId: string) {
    const inventories = await this.inv.findAll({
      where: { variantId, quantity: { [Op.gt]: 0 } }
    });
    for (const invItem of inventories) {
      await this.mov.create({
        shopId: invItem.shopId,
        variantId,
        type: "PRODUCT_DELETION",
        quantity: invItem.quantity,
        reason: "Variant deleted",
        referenceType: "VARIANT",
        referenceId: variantId,
      } as any);
    }
    await this.inv.destroy({ where: { variantId } });
    await this.variant.destroy({ where: { id: variantId, productId: id } });
    return { deleted: true };
  }
  @ApiBearerAuth() @RequirePermissions('products.manageImages') @Post("products/:id/media") createMedia(@Param("id") id: string, @Body() b: MediaDto) {
    return this.media.create({ ...b, productId: id } as any);
  }

  @ApiBearerAuth() @RequirePermissions('products.manageImages') @Delete("products/:id/media/:mediaId") async deleteMedia(@Param("id") id: string, @Param("mediaId") mediaId: string) {
    const mediaItem = await this.media.findOne({ where: { id: mediaId, productId: id } });
    if (mediaItem) {
      if (mediaItem.url) {
        import("@/common/providers/storage.provider").then(m => m.storageProvider.deleteFile(mediaItem.url).catch(console.error));
      }
      await mediaItem.destroy();
    }
    return { success: true };
  }

  @ApiBearerAuth() @RequirePermissions('products.manageImages') @Post("products/:id/media/reorder") async reorderMedia(
    @Param("id") id: string,
    @Body() b: SortOrderDto
  ) {
    for (const item of b.items) {
      await this.media.update({ sortOrder: item.sortOrder }, { where: { id: item.id, productId: id } });
    }
    return { success: true };
  }

  /**
   * The three rails below are public, and all three used to return whatever was
   * in the table — `fbt` in particular returned the four newest products with
   * no `where` at all, so a draft created a minute ago was the likeliest
   * result. They now share the storefront gate with the listing.
   */
  @Public() @Get("products/:id/similar") async similar(@Param("id") id: string) {
    const p = await findByIdOrSlugOr404<Product>(this.product, id, "Product");
    const rows = await this.product.findAll({
      where: {
        categoryId: p.categoryId,
        id: { [Op.ne]: p.id },
        status: "published",
        [Op.and]: [visibleProductClause()],
      },
      include: [
        { model: this.variant, attributes: VARIANT_PUBLIC_ATTRS, include: [sellableInventoryInclude()] },
        this.media,
      ],
      limit: 8,
    });
    return rows.map((row) => {
      const json = row.toJSON() as any;
      return { ...json, availability: availabilityOf(json.variants) };
    });
  }

  @Public() @Get("products/:id/fbt") fbt(@Param("id") _id: string) {
    return this.product.findAll({
      where: { status: "published", [Op.and]: [visibleProductClause()] },
      limit: 4,
      order: [["createdAt", "DESC"]],
    });
  }

  @Public() @Post("products/compare") compare(@Body() b: CompareDto) {
    return this.product.findAll({
      where: { id: b.ids, status: "published", [Op.and]: [visibleProductClause()] },
    });
  }
}
