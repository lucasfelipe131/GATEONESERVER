import IORedis from 'ioredis';
import { Queue } from 'bullmq';

export function createRedis(url) {
  if (!url) throw new Error('REDIS_URL não configurada.');
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: url.startsWith('rediss://') ? {} : undefined
  });
}

export function createQueues(redis) {
  return {
    messages: new Queue('gate-one-messages', { connection: redis }),
    renewals: new Queue('gate-one-renewals', { connection: redis })
  };
}
