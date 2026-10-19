import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { NotificationQueueService } from "./notification.queue";
import { NotificationEventType } from "@/common/enums/notification-event.enum";

@Injectable()
export class SystemEventObserver {
  private readonly logger = new Logger("SystemEventObserver");

  constructor(private readonly notificationQueue: NotificationQueueService) {}

  @OnEvent("admin.notify")
  async handleAdminNotifyEvent(payload: { eventType: NotificationEventType; variables: Record<string, any> }) {
    this.logger.log(`Received admin.notify event for ${payload.eventType}`);
    await this.notificationQueue.broadcastToAdmins(payload.eventType, payload.variables);
  }
}
