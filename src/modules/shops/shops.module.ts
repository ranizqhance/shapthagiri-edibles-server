import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { Shop, User, AuditLog, Order, OrderShipment, OrderItem, ShopInventory, StockMovement, ProductVariant, PaymentRefund, Return } from "@/models";
import { ShopsController } from "./shops.controller";
import { InventoryModule } from "../inventory/inventory.module";

@Module({
  imports: [
    SequelizeModule.forFeature([
      Shop, User, AuditLog, Order, OrderShipment, OrderItem, ShopInventory, StockMovement, ProductVariant, PaymentRefund, Return
    ]),
    // Provides StockTransferService — the single implementation behind both
    // POST /shops/transfer and POST /inventory/transfer.
    InventoryModule
  ],
  controllers: [ShopsController]
})
export class ShopsModule {}

