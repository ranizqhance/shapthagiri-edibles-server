import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { CartController } from "./cart.controller";
import { Cart, CartItem, ProductVariant, ShopInventory, Product, ProductMedia, Brand } from "@/models";
import { CartService } from "./cart.service";
import { PromotionsModule } from "@/modules/promotions/promotions.module";

@Module({
  imports: [
    SequelizeModule.forFeature([Cart, CartItem, ProductVariant, ShopInventory, Product, ProductMedia, Brand]),
    PromotionsModule
  ],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
