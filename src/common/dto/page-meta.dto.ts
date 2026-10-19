import { ApiProperty } from "@nestjs/swagger";
import { PageOptionsDto } from "./page-options.dto";

export class PageMetaDto {
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() totalItems!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty() hasPrev!: boolean;
  @ApiProperty() hasNext!: boolean;

  constructor(options: PageOptionsDto, totalItems: number) {
    this.page = options.page;
    this.limit = options.limit;
    this.totalItems = totalItems;
    this.totalPages = Math.max(1, Math.ceil(totalItems / options.limit));
    this.hasPrev = options.page > 1;
    this.hasNext = options.page < this.totalPages;
  }
}
