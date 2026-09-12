import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  CORE_ERROR_CODES,
  CUSTOMER_CONTEXT_PURPOSES,
  CUSTOMER_CONTEXT_SCOPES,
  contextSnapshotSchema,
  customer360Schema
} from '../src/core/contracts.js';
import {
  contextImpactForEvent,
  freshnessFor,
  provenance,
  selectContextScopes
} from '../src/core/customer-context.js';

const CUSTOMER_ID = '10000000-0000-4000-8000-000000000001';
const SNAPSHOT_ID = '20000000-0000-4000-8000-000000000002';
const CORRELATION_ID = '30000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-08-22T12:00:00.000Z');

test('Customer 360 possui finalidades, scopes e erros versionados', () => {
  assert.deepEqual(CUSTOMER_CONTEXT_PURPOSES, [
    'CONVERSATION', 'RENEWAL', 'PAYMENT', 'SUPPORT', 'SALES'
  ]);
  assert.ok(CUSTOMER_CONTEXT_SCOPES.includes('PENDING_ACTIONS'));
  for (const code of [
    'CUSTOMER_AMBIGUOUS',
    'CONTEXT_UNAVAILABLE',
    'CONTEXT_PARTIAL',
    'SUBSCRIPTION_NOT_FOUND',
    'INVALID_PURPOSE'
  ]) assert.ok(CORE_ERROR_CODES.includes(code));
});

test('JSON Schema canônico publica Customer360.v1 e ContextSnapshot.v1', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../contracts/gate-core-v1.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$defs.customer360.properties.contract.const, 'Customer360.v1');
  assert.equal(schema.$defs.contextSnapshot.properties.contract.const, 'ContextSnapshot.v1');
  const errorCodes = schema.$defs.response.properties.error.oneOf[1]
    .properties.code.enum;
  assert.ok(errorCodes.includes('CONTEXT_UNAVAILABLE'));
  assert.ok(errorCodes.includes('CUSTOMER_AMBIGUOUS'));
});

test('seleção de contexto é mínima e determinada pela finalidade', () => {
  const support = selectContextScopes({
    purpose: 'SUPPORT',
    requestedScopes: ['IDENTITY', 'SUPPORT', 'PAYMENT', 'UNKNOWN']
  });
  assert.deepEqual(support.selected, ['IDENTITY', 'SUPPORT']);
  assert.deepEqual(support.excluded, ['PAYMENT', 'UNKNOWN']);
  assert.deepEqual(support.exclusionReasonCodes, [
    'UNKNOWN_SCOPE', 'PURPOSE_SCOPE_DENIED'
  ]);
  assert.throws(
    () => selectContextScopes({ purpose: 'EXPORT_ALL' }),
    (error) => error.code === 'INVALID_PURPOSE'
  );
  assert.throws(
    () => selectContextScopes({ purpose: 'SUPPORT', requestedScopes: [] }),
    (error) => error.code === 'INSUFFICIENT_CAPABILITY'
  );
});

test('freshness varia por domínio e respeita validade explícita', () => {
  assert.equal(freshnessFor('payment', '2026-08-22T06:00:00.000Z', { now: NOW }), 'CURRENT');
  assert.equal(freshnessFor('conversation', '2026-08-20T12:00:00.000Z', { now: NOW }), 'HISTORICAL');
  assert.equal(freshnessFor('operational_memory', '2026-07-01T12:00:00.000Z', { now: NOW }), 'STALE');
  assert.equal(freshnessFor('preference', '2026-01-01T12:00:00.000Z', { now: NOW }), 'CURRENT');
  assert.equal(freshnessFor('preference', '2026-08-22T10:00:00.000Z', {
    now: NOW,
    validUntil: '2026-08-22T11:00:00.000Z'
  }), 'STALE');
});

test('eventos invalidam somente leituras futuras dos scopes afetados', () => {
  assert.deepEqual(
    contextImpactForEvent('payment.confirmed'),
    {
      event_type: 'payment.confirmed',
      affected_scopes: ['PAYMENT', 'PENDING_ACTIONS'],
      snapshots_are_immutable: true,
      invalidate_future_reads: true
    }
  );
  assert.deepEqual(contextImpactForEvent('message.received').affected_scopes, ['CONVERSATION']);
  assert.deepEqual(
    contextImpactForEvent('customer.created').affected_scopes,
    ['IDENTITY', 'LIFECYCLE']
  );
  assert.deepEqual(contextImpactForEvent('unknown.event'), {
    event_type: 'unknown.event',
    affected_scopes: [],
    snapshots_are_immutable: true,
    invalidate_future_reads: false
  });
});

test('contratos preservam provenance e representam contexto parcial sem inventar dados', () => {
  const state = provenance('ACTIVE', {
    source: 'customers.lifecycle_status',
    sourceId: CUSTOMER_ID,
    observedAt: NOW,
    domain: 'lifecycle',
    now: NOW
  });
  const customer360 = customer360Schema.parse({
    contract: 'Customer360.v1',
    customer_id: CUSTOMER_ID,
    resolution: { status: 'MATCHED', matched_by: null },
    context_status: 'PARTIAL',
    selected_scopes: ['LIFECYCLE', 'SUBSCRIPTION'],
    lifecycle: { state, recent_transition: null },
    subscription: null,
    missing_fields: ['subscription']
  });
  assert.equal(customer360.lifecycle.state.source, 'customers.lifecycle_status');
  assert.equal(customer360.subscription, null);
  assert.deepEqual(customer360.missing_fields, ['subscription']);

  const snapshot = contextSnapshotSchema.parse({
    contract: 'ContextSnapshot.v1',
    context_snapshot_id: SNAPSHOT_ID,
    customer_id: CUSTOMER_ID,
    correlation_id: CORRELATION_ID,
    purpose: 'CONVERSATION',
    channel: 'WHATSAPP',
    created_at: NOW.toISOString(),
    sources: [{ source: 'customers', source_id: CUSTOMER_ID, observed_at: NOW.toISOString() }],
    customer360,
    freshness: { lifecycle: 'CURRENT', subscription: 'UNKNOWN' },
    selected_refs: [{ source: 'customers', source_id: CUSTOMER_ID }],
    excluded_refs: [],
    exclusion_reason_codes: []
  });
  assert.equal(snapshot.context_snapshot_id, SNAPSHOT_ID);
  assert.equal(snapshot.customer360.context_status, 'PARTIAL');
});
