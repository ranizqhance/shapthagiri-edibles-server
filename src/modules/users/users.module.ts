import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { User, UserAddress, UserPaymentMethod } from "@/models";
import { UsersController } from "./users.controller";

@Module({
  imports: [SequelizeModule.forFeature([User, UserAddress, UserPaymentMethod])],
  controllers: [UsersController],
})
export class UsersModule {}
