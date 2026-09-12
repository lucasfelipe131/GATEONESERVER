import { writeSync } from 'node:fs';

export function createOutboxFailpoint(env = process.env) {
  if (env.OUTBOX_FAILPOINT_AFTER_EFFECT_BEFORE_ACK !== 'true') return null;
  if (env.GATE_ENVIRONMENT !== 'staging-055' || env.GATE_TEST_MODE !== 'true' ||
      env.PROVIDER_MODE !== 'fake-only' || !env.OUTBOX_FAILPOINT_CORRELATION_ID ||
      !env.OUTBOX_FAILPOINT_EVENT_TYPE) throw new Error('OUTBOX_FAILPOINT_GUARD_FAILED');
  return ({ event, consumer, workerId, consumed }) => {
    if (!consumed.processed || event.correlation_id !== env.OUTBOX_FAILPOINT_CORRELATION_ID ||
        event.event_type !== env.OUTBOX_FAILPOINT_EVENT_TYPE) return;
    writeSync(1, JSON.stringify({ marker: 'OUTBOX_FAILPOINT_COMMITTED_BEFORE_ACK',
      event_id: event.event_id, consumer, worker_id: workerId, signal: 'SIGKILL' }) + '\n');
    process.kill(process.pid, 'SIGKILL');
  };
}
