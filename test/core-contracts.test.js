import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  CORE_CONTRACT_VERSION,
  CORE_EVENT_TYPES,
  coreRequestSchema,
  coreResponse,
  eventEnvelopeSchema
} from '../src/core/contracts.js';
import { createBusinessEvent } from '../src/core/events.js';
import {
  paymentIdempotencyKey,
  renewalIdempotencyKey
} from '../src/core/idempotency.js';
import { authorizeCoreOperation } from '../src/core/policy.js';
import { provisioningResult, ProvisioningProvider } from '../src/core/provisioning.js';

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const CORRELATION_ID = '20000000-0000-4000-8000-000000000002';
const CUSTOMER_ID = '30000000-0000-4000-8000-000000000003';

function requestEnvelope(overrides = {}) {
  return {
    contract_version: CORE_CONTRACT_VERSION,
    request_id: REQUEST_ID,
    correlation_id: CORRELATION_ID,
    actor: {
      type: 'SERVICE',
      id: 'whatsapp',
      capability: 'customer.identity.resolve'
    },
    action: 'customer.resolve',
    subject: { type: 'customer' },
    input: { type: 'WHATSAPP', value: '5511999999999' },
    ...overrides
  };
}

test('request e response envelopes preservam versão e correlation ID', () => {
  const request = coreRequestSchema.parse(requestEnvelope());
  const response = coreResponse(request, { data: { status: 'MATCHED', customer_id: CUSTOMER_ID } });
  assert.equal(response.contract_version, 1);
  assert.equal(response.request_id, REQUEST_ID);
  assert.equal(response.correlation_id, CORRELATION_ID);
  assert.equal(response.status, 'SUCCESS');
});

test('event envelope exige versão explícita, actor, subject e rastreabilidade', () => {
  const event = createBusinessEvent({
    eventId: '40000000-0000-4000-8000-000000000004',
    eventType: 'payment.confirmed',
    occurredAt: '2026-08-22T12:00:00.000Z',
    correlationId: CORRELATION_ID,
    causationId: null,
    actor: { type: 'SERVICE', id: 'mercadopago' },
    subject: { type: 'payment', id: '50000000-0000-4000-8000-000000000005' },
    payload: { customer_id: CUSTOMER_ID }
  });
  assert.equal(eventEnvelopeSchema.parse(event).event_version, 1);
  assert.equal(event.correlation_id, CORRELATION_ID);
});

test('JSON Schema canônico contém exatamente o catálogo de eventos v1', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../contracts/gate-core-v1.schema.json', import.meta.url),
    'utf8'
  ));
  assert.deepEqual(schema.$defs.event.properties.event_type.enum, [...CORE_EVENT_TYPES]);
  assert.equal(schema.$defs.event.properties.event_version.const, CORE_CONTRACT_VERSION);
});

test('idempotência financeira é estável para duplicatas e separa operações distintas', () => {
  const paymentA = paymentIdempotencyKey('mercadopago', 'payment-123');
  const paymentDuplicate = paymentIdempotencyKey('MercadoPago', 'payment-123');
  const paymentOtherProvider = paymentIdempotencyKey('manual', 'payment-123');
  assert.equal(paymentA, paymentDuplicate);
  assert.notEqual(paymentA, paymentOtherProvider);

  const renewalA = renewalIdempotencyKey(CUSTOMER_ID, 'sub-1', 'payment-1');
  const renewalDuplicate = renewalIdempotencyKey(CUSTOMER_ID, 'sub-1', 'payment-1');
  const renewalOtherPayment = renewalIdempotencyKey(CUSTOMER_ID, 'sub-1', 'payment-2');
  assert.equal(renewalA, renewalDuplicate);
  assert.notEqual(renewalA, renewalOtherPayment);
});

test('WhatsApp só executa ações permitidas e com a capability exata', () => {
  assert.deepEqual(
    authorizeCoreOperation(requestEnvelope().actor, 'customer.resolve'),
    { allowed: true, capability: 'customer.identity.resolve' }
  );
  assert.equal(
    authorizeCoreOperation(
      { type: 'SERVICE', id: 'whatsapp', capability: 'renewal.request' },
      'renewal.execute'
    ).allowed,
    false
  );
  assert.equal(
    authorizeCoreOperation(
      { type: 'SERVICE', id: 'whatsapp', capability: 'customer.context.read' },
      'customer.resolve'
    ).code,
    'INSUFFICIENT_CAPABILITY'
  );
  assert.equal(
    authorizeCoreOperation(
      { type: 'SERVICE', id: 'unknown-service', capability: 'customer.identity.resolve' },
      'customer.resolve'
    ).allowed,
    false
  );
});

test('Core conhece apenas o contrato de provisioning, inclusive ação humana', () => {
  assert.throws(() => new ProvisioningProvider('bitpanel'), /abstrato/);
  assert.deepEqual(
    provisioningResult({ status: 'HUMAN_ACTION_REQUIRED', reason: 'CAPTCHA' }),
    { status: 'HUMAN_ACTION_REQUIRED', data: null, reason: 'CAPTCHA' }
  );
});
