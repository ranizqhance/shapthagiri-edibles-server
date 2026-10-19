import { Body, Controller, Delete, Get, Module, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { BackInStockAlert, PriceDropAlert, Wishlist, WishlistItem, ProductVariant, Product, ProductMedia, Brand, Category, ShopInventory } from "@/models";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { PriceDropAlertDto, WishlistAddDto } from "@/common/dto/common.dto";
import { sellableInventoryInclude } from "@/modules/catalog/availability";

@ApiTags("Wishlist")
@ApiBearerAuth()
@Controller("wishlist")
export class WishlistController {
  constructor(
    @InjectModel(Wishlist) private w: typeof Wishlist,
    @InjectModel(WishlistItem) private wi: typeof WishlistItem,
    @InjectModel(PriceDropAlert) private pda: typeof PriceDropAlert,
    @InjectModel(BackInStockAlert) private bsa: typeof BackInStockAlert,
  ) {}
  private async getOrCreate(userId: string) {
    const [w] = await this.w.findOrCreate({ where: { userId }, defaults: { userId } as any });
    return w;
  }
  @Get() async list(@CurrentUser() u: JwtPayload, @Query("shopId") shopId?: string) {
    const w = await this.getOrCreate(u.sub);
    // Single-serving-shop: include only the serving shop's inventory so the
    // wishlist shows that shop's price/stock (and Out of Stock there).
    const validShopId = !!shopId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopId);
    const invInclude: any = sellableInventoryInclude(validShopId ? shopId : undefined);
    const rawItems = await this.wi.findAll({
      where: { wishlistId: w.id },
      include: [{
        model: ProductVariant,
        include: [{
          model: Product,
          include: [ProductMedia, Brand, Category]
        }, invInclude]
      }]
    });
    const items = rawItems.filter(it => it.variant && it.variant.product);
    /*
     * A saved item whose product has since been withdrawn stays in the list,
     * marked. Dropping it silently would make a wishlist quietly shrink with no
     * explanation; the card uses this flag to disable Add to Cart instead.
     */
    const withFlags = items.map((it) => {
      const json = it.toJSON() as any;
      const sellable = (json.variant?.inventory ?? []).length > 0;
      json.unavailable = json.variant?.product?.status !== "published" || !sellable;
      return json;
    });
    return { wishlist: w, items: withFlags };
  }
  @Post("items") async add(@CurrentUser() u: JwtPayload, @Body() b: WishlistAddDto) {
    const w = await this.getOrCreate(u.sub);
    const [item] = await this.wi.findOrCreate({ where: { wishlistId: w.id, variantId: b.variantId }, defaults: { wishlistId: w.id, variantId: b.variantId } as any });
    return item;
  }
  /** Add the variant if absent, remove it if present — used by the website heart toggle. */
  @Post("toggle") async toggle(@CurrentUser() u: JwtPayload, @Body() b: WishlistAddDto) {
    const w = await this.getOrCreate(u.sub);
    const existing = await this.wi.findOne({ where: { wishlistId: w.id, variantId: b.variantId } });
    if (existing) { await existing.destroy(); return { added: false, removed: true }; }
    const item = await this.wi.create({ wishlistId: w.id, variantId: b.variantId } as any);
    return { added: true, removed: false, item };
  }
  @Delete("items/:id") async rem(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const w = await this.getOrCreate(u.sub);
    await this.wi.destroy({ where: { id, wishlistId: w.id } });
    return { removed: true };
  }
  @Post("price-drop-alerts") priceDrop(@CurrentUser() u: JwtPayload, @Body() b: PriceDropAlertDto) {
    return this.pda.create({ userId: u.sub, ...b } as any);
  }
  @Post("back-in-stock-alerts") backInStock(@CurrentUser() u: JwtPayload, @Body() b: WishlistAddDto) {
    return this.bsa.create({ userId: u.sub, ...b } as any);
  }
}

@Module({
  imports: [SequelizeModule.forFeature([Wishlist, WishlistItem, PriceDropAlert, BackInStockAlert, ProductVariant, Product, ProductMedia, Brand, Category])],
  controllers: [WishlistController],
})
export class WishlistModule {}
