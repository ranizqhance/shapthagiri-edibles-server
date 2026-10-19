import { Sequelize } from "sequelize";
import { PageMetaDto } from "@/common/dto/page-meta.dto";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { NotFoundException } from "@/common/errors/http";

export async function paginate<T>(
  model: any,
  opts: PageOptionsDto,
  where: Record<string, unknown> = {},
  include?: any[],
  extraOpts: any = {}
): Promise<{ items: T[]; meta: PageMetaDto }> {
  let order: any;
  if (opts.sortBy === "discount") {
    order = [
      [
        Sequelize.literal(
          '(SELECT COALESCE(MAX("mrp" - "defaultPrice"), 0) FROM "product_variants" WHERE "product_variants"."productId" = "Product"."id")'
        ),
        opts.order
      ]
    ];
  } else if (opts.sortBy === "price") {
    order = [
      [
        Sequelize.literal(
          '(SELECT MIN("defaultPrice") FROM "product_variants" WHERE "product_variants"."productId" = "Product"."id")'
        ),
        opts.order
      ]
    ];
  } else if (opts.sortBy === "rating") {
    order = [
      [
        Sequelize.literal(
          // COALESCE(..., 4.0) invented a 4-star rating for unreviewed products, so
          // "sort by rating" ranked them above genuinely rated ones. Unrated = 0,
          // and only approved reviews count.
          `(SELECT COALESCE(AVG("rating"), 0) FROM "product_reviews" WHERE "product_reviews"."status" = 'approved' AND "product_reviews"."deletedAt" IS NULL AND "product_reviews"."variantId" IN (SELECT "id" FROM "product_variants" WHERE "product_variants"."productId" = "Product"."id"))`
        ),
        opts.order
      ]
    ];
  } else {
    order = opts.sortBy ? [[opts.sortBy, opts.order]] : [["createdAt", opts.order]];
  }

  const { rows, count } = await model.findAndCountAll({
    where,
    include,
    distinct: include ? true : undefined,
    limit: opts.limit,
    offset: opts.offset,
    order,
    ...extraOpts,
  });
  return { items: rows, meta: new PageMetaDto(opts, count) };
}

export async function findOr404<T>(model: any, id: string, label = "Resource"): Promise<T> {
  const row = await model.findByPk(id);
  if (!row) throw new NotFoundException("NOT_FOUND", `${label} not found`);
  return row as T;
}

export async function findByIdOrSlugOr404<T>(model: any, idOrSlug: string, label = "Resource"): Promise<T> {
  const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(idOrSlug);
  const row = await model.findOne({
    where: isUuid ? { id: idOrSlug } : { slug: idOrSlug }
  });
  if (!row) throw new NotFoundException("NOT_FOUND", `${label} not found`);
  return row as T;
}

