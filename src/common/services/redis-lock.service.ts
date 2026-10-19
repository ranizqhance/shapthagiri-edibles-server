// src/common/services/redis-lock.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { createKvClient, KvClient } from './kv';

// Simple distributed lock based on Redis SET NX PX. Usage: const lock = await redisLock.acquire(key, ttlMs);
// With REDIS_ENABLED=false the lock is in-process only (fine for a single local instance).
@Injectable()
export class RedisLockService {
  private readonly logger = new Logger(RedisLockService.name);
  private readonly client: KvClient;

  constructor() {
    this.client = createKvClient((err) => this.logger.error('Redis error', err));
  }

  /**
   * Acquire a lock for the given key.
   * @param key Unique lock key (e.g., `order:${orderId}`)
   * @param ttlMs Time‑to‑live in milliseconds
   * @returns true if lock acquired, false otherwise
   */
  async acquire(key: string, ttlMs: number = 15000): Promise<boolean> {
    const result = await this.client.set(key, 'locked', 'PX', ttlMs, 'NX');
    const acquired = result === 'OK';
    if (!acquired) {
      this.logger.warn(`Failed to acquire lock for ${key}`);
    }
    return acquired;
  }

  /** Release a previously acquired lock */
  async release(key: string): Promise<void> {
    await this.client.del(key);
  }
}
