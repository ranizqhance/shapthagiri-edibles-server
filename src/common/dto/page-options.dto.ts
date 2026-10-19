import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export enum Order { ASC = "ASC", DESC = "DESC" }

/**
 * Columns any paginated endpoint may be sorted by, plus the three synthetic
 * sorts `paginate()` implements with its own SQL (`price`, `discount`,
 * `rating`).
 */
export const SORTABLE_FIELDS = [
  "createdAt", "updatedAt", "name", "title", "email", "status",
  "quantity", "total", "amount", "code", "sku", "orderNumber",
  "price", "discount", "rating", "relevance",
] as const;

export class PageOptionsDto {
  /**
   * Bounded.
   *
   * `limit` was capped at 100 but `page` had no ceiling, so `?page=100000000`
   * produced an OFFSET in the billions — Postgres counts its way there row by
   * row, which is a cheap request that costs the database a great deal.
   * 10,000 pages is far past anything a person browses to.
   */
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 10_000 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ enum: Order, default: Order.DESC })
  @IsOptional() @IsEnum(Order)
  order: Order = Order.DESC;

  /**
   * The column to sort by.
   *
   * Reaches Sequelize's `order:` in `crud.util.ts`, which quotes the
   * identifier — so this is not an injection — but an arbitrary column name
   * still lets a caller sort by fields that are never displayed (inferring
   * their values from the ordering), and an unknown one turns every paginated
   * endpoint into a 500. Restricted to a conservative, shared set; callers
   * needing more pass an explicit order instead.
   */
  @ApiPropertyOptional({ description: "Field to sort by", example: "createdAt", enum: SORTABLE_FIELDS })
  @IsOptional() @IsString() @IsIn(SORTABLE_FIELDS)
  sortBy?: string;

  @ApiPropertyOptional({ description: "Free-text search" })
  @IsOptional() @IsString() q?: string;

  @ApiPropertyOptional({ description: "Filter by status value" })
  @IsOptional() @IsString() status?: string;

  get offset(): number { return (this.page - 1) * this.limit; }
}
