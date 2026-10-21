import { INestApplicationContext, Logger } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import type { ServerOptions } from "socket.io";
import { env } from "@/config/env";
import { REDIS_OPTIONS } from "@/common/services/kv";

/**
 * Socket.IO across more than one API instance.
 *
 * Without this, a gateway's rooms live in the memory of whichever process
 * accepted the socket. `emitToUser(id, …)` then reaches that customer only if
 * their browser happens to be connected to the same instance that handled the
 * order — so with two replicas roughly half of all notifications, status
 * changes and courier pings silently go nowhere. Nothing errors; the feature
 * just appears unreliable.
 *
 * The Redis adapter puts every emit on a pub/sub channel that all instances
 * subscribe to, so a room is shared across the cluster.
 *
 * Deliberately degrades rather than refuses: if Redis is unavailable the app
 * still starts and real-time still works *within* one instance, which is the
 * correct trade for a shop that would otherwise be entirely down.
 */
function waitUntilReady(client: Redis): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Redis connection timed out")), REDIS_OPTIONS.connectTimeout + 1000);
    client.once("ready", () => { clearTimeout(timer); resolve(); });
  });
}

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger("RedisIoAdapter");
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /** Builds the pub/sub pair. Safe to call when Redis is off or unreachable. */
  async connect(): Promise<void> {
    if (!env.REDIS_ENABLED) {
      this.logger.warn(
        "REDIS_ENABLED=false — Socket.IO rooms are in-process only. Run a single API instance, " +
          "or real-time events will reach only the clients connected to the instance that raised them.",
      );
      return;
    }

    // The adapter needs two connections: one publishes, one subscribes. A
    // subscribed client cannot issue normal commands, which is why it is a
    // duplicate rather than the shared cache client.
    const pubClient = new Redis(REDIS_OPTIONS);
    const subClient = pubClient.duplicate();

    // Never let a Redis problem take the socket layer — or the boot — down.
    pubClient.on("error", (e) => this.logger.warn(`pub: ${e.message}`));
    subClient.on("error", (e) => this.logger.warn(`sub: ${e.message}`));

    try {
      // The shared options disable the offline queue, so a command sent before
      // the socket is up fails at once ("Stream isn't writeable") — which made
      // this check fail on every boot even with Redis running. Wait for both
      // connections first, bounded by the connect timeout.
      await Promise.all([pubClient, subClient].map(waitUntilReady));
      await Promise.all([pubClient.ping(), subClient.ping()]);
      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log(`Socket.IO clustered via Redis at ${env.REDIS_HOST}:${env.REDIS_PORT}`);
    } catch (e) {
      this.logger.error(
        `Could not reach Redis for Socket.IO clustering (${(e as Error).message}). ` +
          "Falling back to in-process rooms — safe on one instance, lossy on several.",
      );
      pubClient.disconnect();
      subClient.disconnect();
    }
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
