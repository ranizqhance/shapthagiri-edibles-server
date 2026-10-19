import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { LoyaltyService } from "./loyalty.service";

/**
 * Daily loyalty points expiry + pre-expiry reminders. Reuses the same `@Cron`
 * pattern as the other scheduled sweeps (jobs/finance/returns). The heavy lifting
 * (FIFO lot accounting, idempotent stamping) lives in LoyaltyService.
 */
@Injectable()
export class LoyaltyExpiryCron {
  private readonly logger = new Logger("LoyaltyExpiryCron");

  constructor(private readonly loyalty: LoyaltyService) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async run() {
    try {
      const res = await this.loyalty.expireDuePoints();
      if (res.pointsExpired > 0 || res.remindersSent > 0) {
        this.logger.log(`Expired ${res.pointsExpired} pts across ${res.accountsProcessed} accounts; ${res.remindersSent} reminders sent.`);
      }
    } catch (e) {
      this.logger.error("Loyalty expiry sweep failed", e as any);
    }
  }
}
