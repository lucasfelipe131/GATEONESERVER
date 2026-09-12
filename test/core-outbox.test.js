import assert from 'node:assert/strict';
import test from 'node:test';
import { createBusinessEvent } from '../src/core/events.js';
import {
  appendOutboxEvent,
  claimOutboxBatch,
  consumeEventIdempotently,
  markOutboxFailed,
  markOutboxPublished
} from '../src/core/outbox.js';

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const CORRELATION_ID = '20000000-0000-4000-8000-000000000002';

function event() {
  return createBusinessEvent({
    eventId: EVENT_ID,
    eventType: 'renewal.ready',
    occurredAt: '2026-08-22T12:00:00.000Z',
    correlationId: CORRELATION_ID,
    actor: { type: 'SYSTEM', id: 'gate-core' },
    subject: { type: 'renewal', id: '30000000-0000-4000-8000-000000000003' },
    payload: {}
  });
}

function fakeDb() {
  const state = { outbox: new Set(), consumed: new Set() };
  const client = {
    async query(sql, params) {
      if (String(sql).includes('INSERT INTO gate_event_outbox')) {
        if (state.outbox.has(params[0])) return { rowCount: 0, rows: [] };
        state.outbox.add(params[0]);
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (String(sql).includes('INSERT INTO gate_event_consumptions')) {
        const key = `${params[0]}:${params[1]}`;
        if (state.consumed.has(key)) return { rowCount: 0, rows: [] };
        state.consumed.add(key);
        return { rowCount: 1, rows: [{ event_id: params[1] }] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    }
  };
  return {
    state,
    client,
    async transaction(callback) {
      const snapshot = new Set(state.consumed);
      try {
        return await callback(client);
      } catch (error) {
        state.consumed = snapshot;
        throw error;
      }
    }
  };
}

test('outbox não persiste duas vezes o mesmo event_id', async () => {
  const db = fakeDb();
  assert.equal((await appendOutboxEvent(db.client, event())).stored, true);
  assert.equal((await appendOutboxEvent(db.client, event())).stored, false);
  assert.equal(db.state.outbox.size, 1);
});

test('consumer crítico ignora evento duplicado', async () => {
  const db = fakeDb();
  let executions = 0;
  const handler = async () => { executions += 1; };
  const first = await consumeEventIdempotently(db, {
    consumer: 'renewal-consumer',
    event: event()
  }, handler);
  const duplicate = await consumeEventIdempotently(db, {
    consumer: 'renewal-consumer',
    event: event()
  }, handler);
  assert.equal(first.processed, true);
  assert.deepEqual(duplicate, { processed: false, duplicate: true });
  assert.equal(executions, 1);
});

test('falha do handler libera o evento para reprocessamento transacional', async () => {
  const db = fakeDb();
  await assert.rejects(
    consumeEventIdempotently(db, { consumer: 'payments', event: event() }, async () => {
      throw new Error('falha transitória');
    }),
    /falha transitória/
  );
  const retried = await consumeEventIdempotently(
    db,
    { consumer: 'payments', event: event() },
    async () => 'ok'
  );
  assert.equal(retried.processed, true);
});

test('claim concorrente usa SKIP LOCKED, lease e incremento persistente', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [{ event_id: EVENT_ID, publish_attempts: 1 }] };
    }
  };
  const claimed = await claimOutboxBatch(client, {
    workerId: 'worker-a', limit: 10, now: new Date('2026-08-23T12:00:00.000Z')
  });
  assert.equal(claimed.length, 1);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[0].sql, /claimed_at < .*interval '5 minutes'/s);
  assert.match(calls[0].sql, /publish_attempts = publish_attempts \+ 1/);
  assert.equal(calls[0].params[2], 'worker-a');
});

test('sucesso só é marcado pelo worker que possui o claim', async () => {
  let sql;
  const client = { async query(query) { sql = String(query); return { rowCount: 1 }; } };
  assert.equal(await markOutboxPublished(client, {
    eventId: EVENT_ID, workerId: 'worker-a', now: new Date()
  }), true);
  assert.match(sql, /claimed_by = \$2/);
  assert.match(sql, /publish_status = 'PUBLISHED'/);
});

test('falha agenda backoff e exceder tentativas vira terminal visível', async () => {
  const rows = [];
  const client = {
    async query(_sql, params) { rows.push(params); return { rowCount: 1 }; }
  };
  const now = new Date('2026-08-23T12:00:00.000Z');
  const retry = await markOutboxFailed(client, {
    eventId: EVENT_ID, workerId: 'worker-a', error: new Error('timeout'),
    attempt: 2, maxAttempts: 3, now, baseDelayMs: 1000
  });
  assert.equal(retry.terminal, false);
  assert.equal(retry.next_attempt_at.toISOString(), '2026-08-23T12:00:02.000Z');
  const terminal = await markOutboxFailed(client, {
    eventId: EVENT_ID, workerId: 'worker-a', error: new Error('permanente'),
    attempt: 3, maxAttempts: 3, now
  });
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.next_attempt_at, null);
  assert.equal(rows[1][4].toISOString(), now.toISOString());
});
