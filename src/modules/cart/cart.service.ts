import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { Cart, CartItem, ProductVariant, ShopInventory } from '@/models';
import { CartAddDto } from '@/common/dto/common.dto';

@Injectable()
export class CartService {
  constructor(
    @InjectModel(Cart) private cartModel: typeof Cart,
    @InjectModel(CartItem) private cartItemModel: typeof CartItem,
    @InjectModel(ProductVariant) private variantModel: typeof ProductVariant,
    @InjectModel(ShopInventory) private inventoryModel: typeof ShopInventory,
  ) {}

  /** Get or create active cart for user */
  private async getOrCreate(userId: string) {
    const [c] = await this.cartModel.findOrCreate({
      where: { userId, status: 'active' },
      defaults: { userId, status: 'active' } as any,
    });
    // Return cart with possible gift card association
    return this.cartModel.findByPk(c.id) as Promise<Cart>;
  }

  /** Add an item to the cart */
  async addItem(dto: CartAddDto, userId: string) {
    const cart = await this.getOrCreate(userId);
    const variant = await this.variantModel.findByPk(dto.variantId);
    if (!variant) throw new NotFoundException('Variant not found');

    // Determine price based on active inventory overrides
    const activeInv = await this.inventoryModel.findAll({
      where: { variantId: dto.variantId, isActive: true, quantity: { [Op.gt]: 0 } },
    });
    let price = Number(variant.defaultPrice || 0);
    if (activeInv.length > 0) {
      price = activeInv.reduce((min, inv) => {
        const p = Number(inv.priceOverride ?? variant.defaultPrice ?? 0);
        return p < min ? p : min;
      }, Infinity);
    }

    return this.cartItemModel.create({
      cartId: cart.id,
      variantId: dto.variantId,
      quantity: dto.quantity,
      priceSnapshot: price,
    } as any);
  }

  /** Backward compatibility alias */
  async add(dto: CartAddDto, userId: string) {
    return this.addItem(dto, userId);
  }

  /** Retrieve cart summary */
  async getCart(userId: string) {
    const cart = await this.cartModel.findOne({ where: { userId, status: 'active' } });
    if (!cart) return { subtotal: 0, discount: 0 };
    const items = await this.cartItemModel.findAll({ where: { cartId: cart.id } });
    const subtotal = items.reduce((s, i) => s + Number(i.priceSnapshot) * i.quantity, 0);
    // Simple placeholder for discount (could be extended later)
    const discount = 0;
    return { subtotal, discount };
  }
}
