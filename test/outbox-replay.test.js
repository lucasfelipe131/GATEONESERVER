import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboxDispatcher } from '../src/core/outbox.js';
import { createBusinessEvent } from '../src/core/events.js';

function fixture() {
  const event = { ...createBusinessEvent({ eventType: 'payment.created',
    actor: { type: 'SYSTEM', id: 'test' }, subject: { type: 'payment', id: '10000000-0000-4000-8000-000000000001' },
    payload: {} }), publish_attempts: 0 };
  let consumed = new Set(), effects = 0, owner = null, published = false, failAck = false;
  let tail = Promise.resolve();
  const client = { async query(sql, params) {
    if (sql.includes('WITH candidates')) {
      if (owner || published) return { rows: [] };
      owner = params[2]; event.publish_attempts++;
      return { rows: [{ ...event }] };
    }
    if (sql.includes('INSERT INTO gate_event_consumptions')) {
      const key = params.join(':'); const duplicate = consumed.has(key); consumed.add(key);
      return { rowCount: duplicate ? 0 : 1 };
    }
    if (sql === 'synthetic-effect') { effects++; return {}; }
    if (sql.includes("publish_status = 'PUBLISHED'")) {
      if (failAck) { failAck = false; throw new Error('crash-before-ack'); }
      published = true; owner = null; return { rowCount: 1 };
    }
    if (sql.includes("publish_status = 'FAILED'")) { owner = null; return { rowCount: 1 }; }
    throw new Error('Unexpected SQL');
  } };
  const db = { async transaction(fn) {
    const previous = tail; let release; tail = new Promise(r => { release = r; }); await previous;
    const snapshot = { consumed: new Set(consumed), effects, owner, published };
    try { return await fn(client); } catch (e) {
      consumed = snapshot.consumed; effects = snapshot.effects; owner = snapshot.owner; published = snapshot.published; throw e;
    } finally { release(); }
  } };
  return { db, client, effects: () => effects, crashAck: () => { failAck = true; }, replay: () => { owner = null; published = false; } };
}

for (const scenario of ['normal', 'duplicate', 'crash-before-ack', 'concurrent', 'restart', 'failure-before-effect', 'failure-after-effect']) {
  test(`durable consumer: ${scenario}`, async () => {
    const f = fixture(); let fail = scenario.startsWith('failure-');
    const handler = async (_event, transactionClient) => {
      if (fail && scenario === 'failure-before-effect') { fail = false; throw new Error('before'); }
      await (transactionClient || f.client).query('synthetic-effect');
      if (fail) { fail = false; throw new Error('after'); }
    };
    const worker = id => new OutboxDispatcher({ db: f.db, workerId: id, handlers: { 'payment.created': handler } });
    if (scenario === 'crash-before-ack' || scenario === 'restart') f.crashAck();
    if (scenario === 'concurrent') await Promise.all([worker('a').dispatchBatch(), worker('b').dispatchBatch()]);
    else await worker('a').dispatchBatch();
    if (scenario !== 'normal') { f.replay(); await worker('b').dispatchBatch(); }
    assert.equal(f.effects(), 1);
  });
}
