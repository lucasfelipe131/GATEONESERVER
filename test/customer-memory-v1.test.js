import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideMemoryConflict,
  memoryValuesEqual,
  normalizeMemoryInput,
  selectRelevantMemories
} from '../src/core/memory.js';
import { saveCustomerMemory } from '../src/services/customer-context.js';

const CUSTOMER_A = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_B = '20000000-0000-4000-8000-000000000002';
const MEMORY_OLD = '30000000-0000-4000-8000-000000000003';
const MEMORY_NEW = '40000000-0000-4000-8000-000000000004';
const NOW = new Date('2026-08-22T12:00:00.000Z');

function memoryDb(existing = null) {
  const state = { existing, inserted: [], updates: [] };
  const client = {
    async query(sql, params = []) {
      if (String(sql).startsWith('SELECT id FROM customers')) {
        return { rows: params[0] === CUSTOMER_A ? [{ id: CUSTOMER_A }] : [] };
      }
      if (String(sql).includes('FROM customer_memories')) {
        return { rows: state.existing ? [state.existing] : [] };
      }
      if (String(sql).startsWith('UPDATE customer_memories')) {
        state.updates.push(params);
        state.existing = {
          ...state.existing,
          status: 'SUPERSEDED',
          superseded_by: params.length > 1 ? params[1] : null
        };
        return { rows: [] };
      }
      if (String(sql).startsWith('INSERT INTO customer_memories')) {
        const row = {
          memory_id: params[0], customer_id: params[1], memory_type: params[2],
          memory_key: params[3], value: JSON.parse(params[4]), source: params[5],
          source_reference: params[6], confidence: params[7], observed_at: params[8],
          valid_from: params[9], valid_until: params[10], status: params[11]
        };
        state.inserted.push(row);
        return { rows: [row] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    }
  };
  return {
    state,
    async transaction(callback) { return callback(client); }
  };
}

function input(overrides = {}) {
  return {
    memoryId: MEMORY_NEW,
    customerId: CUSTOMER_A,
    type: 'PREFERENCE',
    key: 'contact-period',
    value: { period: 'morning' },
    source: 'customer_message',
    sourceReference: 'message-123',
    confidence: 'MEDIUM',
    observedAt: NOW,
    ...overrides
  };
}

test('memória normaliza provenance e compara JSON sem depender da ordem das chaves', () => {
  const normalized = normalizeMemoryInput(input(), { now: NOW });
  assert.equal(normalized.type, 'PREFERENCE');
  assert.equal(normalized.source, 'customer_message');
  assert.equal(normalized.observedAt, NOW.toISOString());
  assert.equal(memoryValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.throws(
    () => normalizeMemoryInput(input({ value: { password: 'não-persistir' } }), { now: NOW }),
    /sensíveis/
  );
  assert.throws(
    () => normalizeMemoryInput(input({ value: 'senha: não-persistir' }), { now: NOW }),
    /sensíveis/
  );
});

test('LOW não substitui silenciosamente memória HIGH', async () => {
  const existing = {
    memory_id: MEMORY_OLD,
    customer_id: CUSTOMER_A,
    memory_type: 'PREFERENCE',
    memory_key: 'contact-period',
    value: { period: 'night' },
    source: 'system_confirmation',
    confidence: 'HIGH',
    status: 'ACTIVE'
  };
  assert.equal(decideMemoryConflict(existing, input({ confidence: 'LOW' })).action, 'DISPUTE');
  const db = memoryDb(existing);
  const result = await saveCustomerMemory(db, input({ confidence: 'LOW' }), { now: NOW });
  assert.equal(result.conflict, true);
  assert.equal(result.memory.status, 'DISPUTED');
  assert.equal(db.state.updates.length, 0);
  assert.equal(db.state.existing.status, 'ACTIVE');
});

test('fato de confiança equivalente supersede preservando a cadeia', async () => {
  const existing = {
    memory_id: MEMORY_OLD,
    customer_id: CUSTOMER_A,
    memory_type: 'PREFERENCE',
    memory_key: 'contact-period',
    value: { period: 'night' },
    source: 'customer_message',
    confidence: 'MEDIUM',
    status: 'ACTIVE'
  };
  const db = memoryDb(existing);
  const result = await saveCustomerMemory(db, input(), { now: NOW });
  assert.equal(result.decision.action, 'SUPERSEDE');
  assert.equal(db.state.existing.status, 'SUPERSEDED');
  assert.equal(db.state.existing.superseded_by, MEMORY_NEW);
  assert.deepEqual(db.state.updates, [[MEMORY_OLD], [MEMORY_OLD, MEMORY_NEW]]);
  assert.equal(result.memory.status, 'ACTIVE');
});

test('seleção relevante exclui memória expirada, disputada e de outro cliente', () => {
  const rows = [
    {
      memory_id: MEMORY_OLD, customer_id: CUSTOMER_A, memory_type: 'PREFERENCE',
      memory_key: 'contact-period', value: { period: 'morning' }, source: 'customer_message',
      source_reference: null, confidence: 'MEDIUM', observed_at: NOW.toISOString(),
      valid_from: null, valid_until: null, superseded_by: null, status: 'ACTIVE'
    },
    {
      memory_id: '50000000-0000-4000-8000-000000000005', customer_id: CUSTOMER_A,
      memory_type: 'OPERATIONAL_NOTE', memory_key: 'temporary-error', value: { code: 'X' },
      source: 'support', source_reference: null, confidence: 'HIGH',
      observed_at: '2026-07-01T12:00:00.000Z', valid_from: null,
      valid_until: '2026-07-02T12:00:00.000Z', superseded_by: null, status: 'ACTIVE'
    },
    {
      memory_id: '60000000-0000-4000-8000-000000000006', customer_id: CUSTOMER_B,
      memory_type: 'PREFERENCE', memory_key: 'contact-period', value: { period: 'night' },
      source: 'customer_message', source_reference: null, confidence: 'HIGH',
      observed_at: NOW.toISOString(), valid_from: null, valid_until: null,
      superseded_by: null, status: 'DISPUTED'
    }
  ];
  const selected = selectRelevantMemories(
    rows.filter((row) => row.customer_id === CUSTOMER_A),
    { limit: 5, now: NOW }
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].memory_id, MEMORY_OLD);
  assert.equal(selected.some((item) => item.customer_id === CUSTOMER_B), false);
});
