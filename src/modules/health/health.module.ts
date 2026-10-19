import { Controller, Get, Module } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Sequelize } from "sequelize-typescript";
import { Public } from "@/common/decorators/public.decorator";
import { InjectConnection } from "@nestjs/sequelize";
import { NotificationQueueService } from "../notifications/notification.queue";
import { NotificationsModule } from "../notifications/notifications.module";
import { Throttle } from "@nestjs/throttler";

@ApiTags("Health")
@Controller()
export class HealthController {
  constructor(
    @InjectConnection() private sequelize: Sequelize,
    private queueService: NotificationQueueService,
  ) {}

  @Public()
  @Get("health")
  async health() {
    const queueHealth = await this.queueService.getHealth();
    return {
      status: queueHealth.redis === "unhealthy" ? "degraded" : "ok",
      uptime: process.uptime(),
      redis: queueHealth.redis,
      queue: queueHealth.queue,
      jobs: queueHealth.jobs,
    };
  }

  @Public() @Get("live") live() { return { status: "alive" }; }
  // Hits Postgres and Redis on every call, unauthenticated — an amplifier
  // worth bounding.
  @Public() @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Get("ready") async ready() {
    await this.sequelize.authenticate();
    const queueHealth = await this.queueService.getHealth();
    return {
      status: queueHealth.redis === "unhealthy" ? "degraded" : "ready",
      db: "ok",
      redis: queueHealth.redis,
    };
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [HealthController],
})
export class HealthModule {}
