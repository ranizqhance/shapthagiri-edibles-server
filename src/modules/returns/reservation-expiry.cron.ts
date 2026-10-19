import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Transaction } from 'sequelize';
import { ExchangeFulfillmentService } from './exchange-fulfillment.service';

@Injectable()
export class ReservationExpiryCron {
  private readonly logger = new Logger(ReservationExpiryCron.name);

  constructor(
    @InjectConnection() private sequelize: Sequelize,
    private readonly fulfillmentService: ExchangeFulfillmentService
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleExpiredReservations() {
    this.logger.log('Starting expired reservations sweep...');
    let processedCount = 0;
    const failedIds: string[] = [];

    try {
      // Limit to 10 batches of 50 to prevent infinite loops in a single run
      for (let batch = 0; batch < 10; batch++) {
        // Fetch a batch of expired reservations using SKIP LOCKED
        // This ensures distributed-safe execution when multiple nodes run the cron
        const reservations = await this.sequelize.query(
          `
          SELECT id 
          FROM inventory_reservations 
          WHERE status = 'RESERVED' 
            AND "expiresAt" < NOW() 
            ${failedIds.length > 0 ? 'AND id NOT IN (:failedIds)' : ''}
          FOR UPDATE SKIP LOCKED 
          LIMIT 50
          `,
          {
            replacements: failedIds.length > 0 ? { failedIds } : {},
            type: 'SELECT'
          }
        ) as { id: string }[];

        if (reservations.length === 0) {
          break; // No more expired reservations
        }

        // Process each reservation in its own transaction
        for (const { id } of reservations) {
          try {
            await this.sequelize.transaction(async (t: Transaction) => {
              // The fulfillment service handles stock restoration, status updates, and notifications
              await this.fulfillmentService.expireReservation(id, t);
            });
            processedCount++;
          } catch (error) {
            this.logger.error(`Failed to process expired reservation ${id}`, error);
            failedIds.push(id);
          }
        }
      }
    } catch (error) {
      this.logger.error('Error during expired reservations sweep', error);
    }

    if (processedCount > 0) {
      this.logger.log(`Completed sweep. Processed ${processedCount} expired reservations.`);
    }
  }
}
