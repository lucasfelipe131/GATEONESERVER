import assert from 'node:assert/strict';
import test from 'node:test';
import { createBusinessEvent } from '../src/core/events.js';
import { appendOutboxEvent, consumeEventIdempotently } from '../src/core/outbox.js';

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
