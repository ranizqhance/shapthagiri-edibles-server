import { getFirebase } from "@/config/firebase";
import { logger } from "@/common/utils/logger";

export class PushProvider {
  async send(token: string, title: string, body: string, data: Record<string, string> = {}): Promise<void> {
    const fb = getFirebase();
    if (!fb) {
      logger.info(`[Push stub] → ${token.slice(0, 8)}... | ${title}`);
      return;
    }
    try {
      const id = await fb.messaging().send({
        token,
        notification: { title, body },
        data,
      });
      logger.info(`Push sent (id=${id})`);
    } catch (e) {
      logger.error("FCM send failed", { error: e });
    }
  }

  async sendMulticast(tokens: string[], title: string, body: string, data: Record<string, string> = {}): Promise<void> {
    const fb = getFirebase();
    if (!fb || !tokens.length) {
      logger.info(`[Push multicast stub] → ${tokens.length} tokens | ${title}`);
      return;
    }
    try {
      const res = await fb.messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data,
      });
      logger.info(`Push multicast: ${res.successCount} ok / ${res.failureCount} failed`);
    } catch (e) {
      logger.error("FCM multicast failed", { error: e });
    }
  }
}

export const pushProvider = new PushProvider();
