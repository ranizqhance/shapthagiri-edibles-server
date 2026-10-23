import { Throttle } from "@nestjs/throttler";
import { LIMITS } from "@/common/security/throttle";
import { Controller, Get, Module, Query, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { Op, Sequelize } from "sequelize";
import { Product, SearchQuery, Brand, Category, ProductVariant, ProductMedia } from "@/models";
import { Public } from "@/common/decorators/public.decorator";
import { visibleProductClause } from "@/modules/catalog/availability";
import { VARIANT_PUBLIC_ATTRS } from "@/common/security/public-attributes";

@ApiTags("Search")
@Controller("search")
export class SearchController {
  constructor(@InjectModel(Product) private product: typeof Product, @InjectModel(SearchQuery) private query: typeof SearchQuery) {}

  /**
   * Restrict results to products the serving shop actually stocks. Search was the
   * one storefront surface that stayed global after location selection, so a
   * customer could search up a product their shop cannot deliver. `shopId` is
   * validated as a UUID before interpolation.
   */
  private servingShopFilter(shopId?: string) {
    // Every search result also has to clear the storefront gate: a product
    // switched off on the Inventory screen must not be findable by name.
    const valid = !!shopId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopId);
    if (!valid) return [visibleProductClause() as any];
    return [
      visibleProductClause() as any,
      Sequelize.literal(
        `EXISTS (SELECT 1 FROM "shop_inventory" INNER JOIN "product_variants" ON "product_variants"."id" = "shop_inventory"."variantId" WHERE "product_variants"."productId" = "Product"."id" AND "shop_inventory"."shopId" = '${shopId}' AND "shop_inventory"."isActive" = true AND "shop_inventory"."quantity" > 0)`,
      ) as any,
    ];
  }

  @Throttle(LIMITS.search)
  @Public() @Get("products") async products(@Query("q") q: string, @Req() req: any, @Query("shopId") shopId?: string) {
    // Clipped: a search term past 100 characters is not a product search, and
    // the log column holds 200 — longer input used to fail the insert with a
    // 500 after the search had already run.
    const term = String(q ?? "").trim().slice(0, 100);
    const rows = term ? await this.product.findAll({
      include: [
        { model: Brand, as: "brand", attributes: ["name"] },
        { model: Category, as: "category", attributes: ["name"] },
        { model: ProductVariant, attributes: VARIANT_PUBLIC_ATTRS },
        { model: ProductMedia },
      ],
      where: { status: "published",
        [Op.and]: this.servingShopFilter(shopId),
        [Op.or]: [
          { title: { [Op.iLike]: `%${term}%` } as any },
          { subtitle: { [Op.iLike]: `%${term}%` } as any },
          { description: { [Op.iLike]: `%${term}%` } as any },
          { "$brand.name$": { [Op.iLike]: `%${term}%` } as any },
          { "$category.name$": { [Op.iLike]: `%${term}%` } as any },
        ]},
      limit: 30,
      subQuery: false,
    }) : [];
    // Anonymous input, written on every call: nothing for an empty search, and
    // the text is shown back to staff and on /search/popular — rendered as
    // text there (React escapes it), never as HTML.
    if (term) await this.query.create({ userId: req.user?.sub ?? null, query: term, resultsCount: rows.length } as any);
    return rows;
  }

  @Throttle(LIMITS.search)
  @Public() @Get("suggestions") sugg(@Query("q") q: string, @Query("shopId") shopId?: string) {
    const term = (q ?? "").trim();
    if (!term) return [];
    return this.product.findAll({
      where: { title: { [Op.iLike]: `${term}%` } as any, status: "published", [Op.and]: this.servingShopFilter(shopId) },
      attributes: ["id", "title"],
      limit: 8,
    });
  }

  @Throttle(LIMITS.search)
  @Public() @Get("popular") popular() {
    return this.query.findAll({
      attributes: ["query", [this.query.sequelize!.fn("COUNT", this.query.sequelize!.col("query")), "count"]],
      group: ["query"],
      order: [[this.query.sequelize!.literal("count"), "DESC"]],
      limit: 10,
    });
  }
}

@Module({ imports: [SequelizeModule.forFeature([Product, SearchQuery])], controllers: [SearchController] })
export class SearchModule {}
