import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { User, OtpCode, UserSession } from "@/models";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";
import { env } from "@/config/env";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [
    SequelizeModule.forFeature([User, OtpCode, UserSession]),
    NotificationsModule,
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.register({ secret: env.JWT_ACCESS_SECRET, signOptions: { expiresIn: env.JWT_ACCESS_EXPIRES } as any }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [JwtStrategy, PassportModule],
})
export class AuthModule {}
