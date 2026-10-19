import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { BadRequestException, NotFoundException } from "@/common/errors/http";
import { Deal, Product } from "@/models";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate } from "@/common/utils/crud.util";
import { DealDto, UpdateDealDto } from "@/common/dto/common.dto";

/**
 * Admin CRUD for Deal-of-the-Day promotions (managed from the Marketing module).
 * Storefront READ lives in the catalog StorefrontService — this side only
 * curates the rows.
 */
@Injectable()
export class DealsService {
  constructor(
    @InjectModel(Deal) private deal: typeof Deal,
    @InjectModel(Product) private product: typeof Product,
  ) {}

  list(opts: PageOptionsDto) {
    return paginate(this.deal, opts, {}, [
      { model: Product, attributes: ["id", "title", "subtitle"] },
    ]);
  }

  private validate(dto: Partial<DealDto>) {
    if (dto.discountType && !["pct", "flat"].includes(dto.discountType)) {
      throw new BadRequestException("BAD_REQUEST", "discountType must be 'pct' or 'flat'");
    }
    if (dto.discountValue != null) {
      if (Number(dto.discountValue) <= 0) {
        throw new BadRequestException("BAD_REQUEST", "discountValue must be greater than 0");
      }
      if (dto.discountType === "pct" && Number(dto.discountValue) > 100) {
        throw new BadRequestException("BAD_REQUEST", "Percentage discount cannot exceed 100");
      }
    }
    if (dto.startsAt && dto.endsAt && new Date(dto.endsAt) <= new Date(dto.startsAt)) {
      throw new BadRequestException("BAD_REQUEST", "End date must be after start date");
    }
  }

  async create(dto: DealDto, userId?: string) {
    this.validate(dto);
    const product = await this.product.findByPk(dto.productId);
    if (!product) throw new BadRequestException("BAD_REQUEST", "Product not found");
    return this.deal.create({
      productId: dto.productId,
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      priority: dto.priority ?? 0,
      isActive: dto.isActive ?? true,
      createdBy: userId ?? null,
    } as any);
  }

  async update(id: string, dto: UpdateDealDto) {
    const deal = await this.deal.findByPk(id);
    if (!deal) throw new NotFoundException("NOT_FOUND", "Deal not found");
    // Validate against the merged end-state so partial edits are still checked.
    this.validate({
      discountType: dto.discountType ?? deal.discountType,
      discountValue: dto.discountValue ?? Number(deal.discountValue),
      startsAt: dto.startsAt ?? (deal.startsAt ? deal.startsAt.toISOString() : undefined),
      endsAt: dto.endsAt ?? (deal.endsAt ? deal.endsAt.toISOString() : undefined),
    });
    if (dto.productId) {
      const product = await this.product.findByPk(dto.productId);
      if (!product) throw new BadRequestException("BAD_REQUEST", "Product not found");
    }
    await deal.update({
      ...(dto.productId !== undefined ? { productId: dto.productId } : {}),
      ...(dto.discountType !== undefined ? { discountType: dto.discountType } : {}),
      ...(dto.discountValue !== undefined ? { discountValue: dto.discountValue } : {}),
      ...(dto.startsAt !== undefined ? { startsAt: dto.startsAt ? new Date(dto.startsAt) : null } : {}),
      ...(dto.endsAt !== undefined ? { endsAt: dto.endsAt ? new Date(dto.endsAt) : null } : {}),
      ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    } as any);
    return deal;
  }

  async remove(id: string) {
    const deal = await this.deal.findByPk(id);
    if (!deal) throw new NotFoundException("NOT_FOUND", "Deal not found");
    await deal.destroy();
    return { deleted: true };
  }
}
