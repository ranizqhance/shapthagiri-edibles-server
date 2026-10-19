import { Body, Controller, Delete, Get, Param, Patch, Post, NotFoundException } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { Cart, CartItem, ProductVariant, ShopInventory, Product, ProductMedia, Brand, GiftCard, Shop } from "@/models";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { CartEmptyException } from "@/common/errors/domain";
// App error class — the global filter renders raw NestJS HttpExceptions as 500.
import { BadRequestException as ShopBadRequest } from "@/common/errors/http";
import { CartAddDto, CartMergeDto, CartUpdateDto, CouponApplyDto, DeliveryModeDto } from "@/common/dto/common.dto";
import { ApplyGiftCardDto } from "@/common/dto/gift-card.dto";
import { GiftCardService } from "@/modules/promotions/gift-card.service";

// A guest cart is a handful of lines; anything far beyond that is a forged
// request trying to make the server price a catalogue inside one transaction.
const MERGE_MAX_LINES = 50;

/**
 * Inventory a cart may price from: an active row, at a shop that still exists
 * and is itself active.
 *
 * The cart used to accept any `isActive` row. Rows belonging to a removed shop
 * survive — `shop_inventory` is not paranoid and nothing cascades — so they
 * kept counting toward availability here while being invisible to the admin
 * Inventory screen.
 */
const LIVE_SHOP_INCLUDE = [
  { model: Shop, as: "shop", attributes: [] as string[], required: true, where: { isActive: true } },
];

@ApiTags("Cart")
@ApiBearerAuth()
@Controller("cart")
export class CartController {
  constructor(
    @InjectModel(Cart) private cart: typeof Cart,
    @InjectModel(CartItem) private item: typeof CartItem,
    @InjectModel(ProductVariant) private variant: typeof ProductVariant,
    @InjectModel(ShopInventory) private inv: typeof ShopInventory,
    private giftCardService: GiftCardService,
  ) {}

  private async getOrCreate(userId: string) {
    const [c] = await this.cart.findOrCreate({ 
      where: { userId, status: "active" }, 
      defaults: { userId, status: "active" } as any 
    });
    // Include the applied gift card: the checkout summary prices the discount
    // from `cart.giftCard.balance`. Without it the cart carried only
    // `giftCardId`, so an applied card was invisible in the summary (it showed
    // no discount and the full amount as payable) even though the backend
    // deducted it at placement.
    return this.cart.findByPk(c.id, { include: [{ model: GiftCard, required: false }] }) as Promise<Cart>;
  }

  @Get()
  async get(@CurrentUser() u: JwtPayload) {
    const cart = await this.getOrCreate(u.sub);
    const rawItems = await this.item.findAll({
      where: { cartId: cart.id },
      include: [{
        model: this.variant,
        include: [{
          model: Product,
          include: [ProductMedia, Brand]
        }]
      }]
    });

    const items = rawItems.filter(it => it.variant && it.variant.product);

    // Stock for every line in ONE query, then matched in memory.
    //
    // This was a `findAll` per line inside a serial loop, and the header fires
    // this endpoint on every page — so a five-line cart meant six round trips
    // on every navigation. The shop scoping is unchanged: a line pinned to a
    // shop is judged on that shop's stock, and a legacy line with no shopId on
    // all-shop stock.
    const flags: any[] = [];
    if (items.length) {
      // Active rows at live shops only — the same rule the storefront and the
      // admin Inventory screen use, so a cart cannot be judged against stock
      // nobody else can see.
      const rows = await this.inv.findAll({
        where: {
          variantId: { [Op.in]: [...new Set(items.map((i) => i.variantId))] },
          isActive: true,
        },
        attributes: ["variantId", "shopId", "isActive", "quantity"],
        include: LIVE_SHOP_INCLUDE,
      });
      for (const it of items) {
        const live = rows.filter(
          (r) => r.variantId === it.variantId && (it.shopId ? r.shopId === it.shopId : true),
        );
        /*
         * Withdrawn is reported separately from sold out.
         *
         * The line is left in the cart and flagged rather than dropped: a line
         * disappearing with no explanation is worse than one the shopper can
         * see and remove, and checkout refuses it either way.
         */
        if ((it.variant as any)?.product?.status !== "published" || live.length === 0) {
          flags.push({ variantId: it.variantId, issue: "unavailable" });
          continue;
        }
        const stock = live.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
        if (stock < it.quantity) flags.push({ variantId: it.variantId, issue: "out_of_stock" });
      }
    }
    const subtotal = items.reduce((s, i) => s + Number(i.priceSnapshot) * i.quantity, 0);
    return { cart, items, subtotal, flags };
  }

  /**
   * Price one line the way the cart always has: from the serving shop when one
   * is resolved, otherwise the cheapest active inventory row.
   *
   * Extracted from add() so merge() prices guest lines identically — a line must
   * not cost a different amount depending on whether it was added before or
   * after signing in.
   */
  /**
   * Units of `variantId` a customer can actually buy, from the serving shop when
   * the line is pinned to one and across active shops when it is not.
   */
  private async availableFor(variantId: string, shopId?: string | null): Promise<number> {
    const where: any = shopId
      ? { variantId, shopId, isActive: true }
      : { variantId, isActive: true };
    const rows = await this.inv.findAll({ where, include: LIVE_SHOP_INCLUDE });
    return rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  }

  private async priceLine(variantId: string, quantity: number, rawShopId?: string) {
    const v = await this.variant.findByPk(variantId, {
      include: [{ model: Product, attributes: ["id", "status"], required: false }],
    });
    if (!v) throw new NotFoundException("Variant not found");

    // A product taken off the storefront must not be addable or repricable.
    // Only the buy-now path asserted this; the cart path did not, so an
    // archived product already sitting in a cart could still be bought.
    if ((v as any).product?.status !== "published") {
      throw new ShopBadRequest("INV_OUT_OF_STOCK", "This item is no longer available.");
    }

    const validShopId = !!rawShopId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawShopId);
    let price: number;
    let shopId: string | null = null;

    if (validShopId) {
      // Single-serving-shop: price + availability come from the serving shop only.
      // Unavailable there → block the add (purchase prevented).
      const inv = await this.inv.findOne({
        where: { variantId, shopId: rawShopId, isActive: true },
        include: LIVE_SHOP_INCLUDE,
      });
      const available = inv ? Number(inv.quantity) : 0;
      if (available < quantity) {
        throw new ShopBadRequest("INV_OUT_OF_STOCK", "This item is out of stock at your store.");
      }
      price = Number(inv!.priceOverride ?? v.defaultPrice ?? 0);
      shopId = rawShopId!;
    } else {
      // Fallback (no serving shop resolved): legacy global-min price.
      const activeInv = await this.inv.findAll({
        where: { variantId, isActive: true, quantity: { [Op.gt]: 0 } },
        include: LIVE_SHOP_INCLUDE,
      });
      const available = activeInv.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
      if (available < quantity) {
        throw new ShopBadRequest(
          "INV_OUT_OF_STOCK",
          available > 0 ? `Only ${available} left in stock.` : "This item is out of stock.",
        );
      }
      price = Number(v.defaultPrice || 0);
      if (activeInv.length > 0) {
        price = activeInv.reduce((min, inv) => {
          const p = Number(inv.priceOverride ?? v.defaultPrice ?? 0);
          return p < min ? p : min;
        }, Infinity);
      }
    }

    return { price, shopId };
  }

  @Post("items")
  async add(@CurrentUser() u: JwtPayload, @Body() body: CartAddDto) {
    const cart = await this.getOrCreate(u.sub);
    const { price, shopId } = await this.priceLine(body.variantId, body.quantity, body.shopId);
    return this.item.create({ cartId: cart.id, variantId: body.variantId, quantity: body.quantity, priceSnapshot: price, shopId } as any);
  }

  /**
   * Fold a guest's browser-local cart into their server cart at sign-in.
   *
   * Shoppers fill a cart anonymously and only identify themselves at checkout;
   * without this those lines would be dropped the moment a token exists, since
   * the client then reads the (empty) server cart as the source of truth.
   *
   * Quantities are taken as `max`, not summed, so the merge is idempotent — a
   * retry after a dropped connection cannot silently double an order. Lines
   * that cannot be priced or stocked are skipped rather than failing the whole
   * request: losing one unavailable item must not cost the customer the cart.
   */
  @Post("merge")
  async merge(@CurrentUser() u: JwtPayload, @Body() body: CartMergeDto) {
    const cart = await this.getOrCreate(u.sub);
    const skipped: Array<{ variantId: string; reason: string }> = [];

    for (const line of body.items.slice(0, MERGE_MAX_LINES)) {
      try {
        const { price, shopId } = await this.priceLine(line.variantId, line.quantity, line.shopId);
        const existing = await this.item.findOne({ where: { cartId: cart.id, variantId: line.variantId, shopId } });
        if (existing) {
          if (line.quantity > existing.quantity) await existing.update({ quantity: line.quantity });
        } else {
          await this.item.create({ cartId: cart.id, variantId: line.variantId, quantity: line.quantity, priceSnapshot: price, shopId } as any);
        }
      } catch (e: any) {
        skipped.push({ variantId: line.variantId, reason: e?.code || e?.message || "unavailable" });
      }
    }

    return { ...(await this.get(u)), skipped };
  }

  @Patch("items/:id")
  async patch(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() body: CartUpdateDto) {
    const cart = await this.getOrCreate(u.sub);
    const item = await this.item.findOne({ where: { id, cartId: cart.id } });
    if (!item) throw new NotFoundException("Item not found");

    const updatePayload: any = { ...body };

    // A plain quantity change used to skip every check below and write straight
    // through, so the cart could hold more units than exist and the customer
    // only found out when placement threw. Validate it here, where we can still
    // say how many there are.
    if (body.quantity != null && (!body.variantId || body.variantId === item.variantId)) {
      const available = await this.availableFor(item.variantId, item.shopId);
      if (available < body.quantity) {
        throw new ShopBadRequest(
          "INV_OUT_OF_STOCK",
          available > 0 ? `Only ${available} left in stock.` : "This item is out of stock.",
        );
      }
    }

    // If changing variant, we MUST validate stock first
    if (body.variantId && body.variantId !== item.variantId) {
      const v = await this.variant.findByPk(body.variantId);
      if (!v) throw new NotFoundException("Variant not found");
      
      const requestedQty = body.quantity ?? item.quantity;
      // Validate + reprice against the line's serving shop (single-serving-shop);
      // legacy lines with no shopId fall back to all-shop availability.
      const stockWhere: any = item.shopId
        ? { variantId: body.variantId, shopId: item.shopId, isActive: true }
        : { variantId: body.variantId, isActive: true };
      const stockRecords = await this.inv.findAll({ where: stockWhere });
      const availableStock = stockRecords.reduce((s, r) => s + (r.quantity || 0), 0);

      if (availableStock < requestedQty) {
        throw new ShopBadRequest("INV_OUT_OF_STOCK", `Only ${availableStock} units available at your store.`);
      }

      const activeInv = stockRecords.filter(r => (r.quantity || 0) > 0);
      let price = Number(v.defaultPrice || 0);
      if (activeInv.length > 0) {
        price = activeInv.reduce((min, inv) => {
          const p = Number(inv.priceOverride ?? v.defaultPrice ?? 0);
          return p < min ? p : min;
        }, Infinity);
      }

      updatePayload.priceSnapshot = price;
    }

    await item.update(updatePayload);
    return item;
  }

  @Delete("items/:id")
  async del(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    const cart = await this.getOrCreate(u.sub);
    await this.item.destroy({ where: { id, cartId: cart.id } });
    return { removed: true };
  }

  @Post("coupon")
  async applyCoupon(@CurrentUser() u: JwtPayload, @Body() body: CouponApplyDto) {
    const c = await this.getOrCreate(u.sub); await c.update({ couponCode: body.code }); return c;
  }

  @Delete("coupon")
  async removeCoupon(@CurrentUser() u: JwtPayload) {
    const c = await this.getOrCreate(u.sub); await c.update({ couponCode: null }); return c;
  }

  @Post("delivery-mode")
  async mode(@CurrentUser() u: JwtPayload, @Body() body: DeliveryModeDto) {
    const c = await this.getOrCreate(u.sub); await c.update({ deliveryMode: body.mode }); return c;
  }

  /**
   * Revalidate the cart against a (new) serving shop — called when the customer
   * changes their delivery address/shop. Available lines are re-pinned + repriced
   * to the new shop; lines the new shop can't fulfil are removed. Returns a summary
   * so the storefront can tell the customer what changed.
   */
  @Post("reprice")
  async reprice(@CurrentUser() u: JwtPayload, @Body() body: { shopId?: string }) {
    const cart = await this.getOrCreate(u.sub);
    const items = await this.item.findAll({ where: { cartId: cart.id } });
    const validShopId = !!body.shopId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.shopId);
    if (!validShopId) return { repricedCount: 0, removedCount: 0 };

    let repricedCount = 0;
    let removedCount = 0;
    for (const it of items) {
      const v = await this.variant.findByPk(it.variantId);
      const inv = await this.inv.findOne({ where: { variantId: it.variantId, shopId: body.shopId, isActive: true } });
      const available = inv ? Number(inv.quantity) : 0;
      if (!v || available < it.quantity) {
        // The new serving shop can't fulfil this line → remove it.
        await it.destroy();
        removedCount++;
        continue;
      }
      const newPrice = Number(inv!.priceOverride ?? v.defaultPrice ?? 0);
      if (it.shopId !== body.shopId || Number(it.priceSnapshot) !== newPrice) {
        await it.update({ shopId: body.shopId, priceSnapshot: newPrice });
        repricedCount++;
      }
    }
    return { repricedCount, removedCount };
  }

  @Post("checkout-validate")
  async validateCheckout(@CurrentUser() u: JwtPayload) {
    const c = await this.getOrCreate(u.sub);
    const items = await this.item.findAll({ where: { cartId: c.id } });
    if (!items.length) throw new CartEmptyException();
    return { valid: true, itemCount: items.length };
  }

  @Post("gift-card")
  async applyGiftCard(@CurrentUser() u: JwtPayload, @Body() body: ApplyGiftCardDto) {
    const cart = await this.getOrCreate(u.sub);
    
    const rawItems = await this.item.findAll({ where: { cartId: cart.id } });
    const subtotal = rawItems.reduce((s, i) => s + Number(i.priceSnapshot) * i.quantity, 0);
    
    // Will throw exception if invalid
    const gc = await this.giftCardService.validateForCart(body.code, u.sub, subtotal);
    
    await cart.update({ giftCardId: gc.id });
    return { message: "Gift card applied successfully", cart, balance: gc.balance };
  }

  @Delete("gift-card")
  async removeGiftCard(@CurrentUser() u: JwtPayload) {
    const cart = await this.getOrCreate(u.sub);
    await cart.update({ giftCardId: null });
    return { message: "Gift card removed successfully", cart };
  }
}
