import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { AuditLog, Category, Product, ProductVariant, ShopInventory, StockMovement, Shop, User } from "@/models";
import { InventoryController } from "./inventory.controller";
import { NotificationsModule } from "../notifications/notifications.module";
import { StockTransferService } from "./stock-transfer.service";

import { ExchangeApprovedListener } from "./listeners/exchange-approved.listener";

@Module({
  imports: [
    SequelizeModule.forFeature([ShopInventory, StockMovement, ProductVariant, Product, Category, Shop, User, AuditLog]),
    NotificationsModule
  ],
  controllers: [InventoryController],
  providers: [ExchangeApprovedListener, StockTransferService],
  // Shared with ShopsModule so the Shop Network "Transfer" button and the
  // inventory endpoint run the exact same transactional logic.
  exports: [StockTransferService]
})
export class InventoryModule {}
