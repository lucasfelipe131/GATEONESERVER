import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRenewalInvariants,
  expirationForPlan,
  transitionRenewal
} from '../src/core/renewal-orchestrator.js';
import { FakeProvisioningProvider } from '../src/core/provisioning-orchestrator.js';
import { RenewalOrchestrator } from '../src/services/renewal-orchestration.js';

const IDS = {
  renewal: '10000000-0000-4000-8000-000000000001',
  customer: '20000000-0000-4000-8000-000000000002',
  subscription: '30000000-0000-4000-8000-000000000003',
  payment: '40000000-0000-4000-8000-000000000004',
  correlation: '50000000-0000-4000-8000-000000000005'
};

class MemoryRenewalRepository {
  constructor() { this.sagas = new Map(); }
  async createOrGet(input) {
    const existing = [...this.sagas.values()].find((item) => item.payment_id === input.payment_id);
    if (existing) return { ...existing, inserted: false };
    const saga = {
      ...input, attempts: 0, revision: 0,
      payment: { id: input.payment_id, status: 'CONFIRMED', amount_cents: 3000,
        customer_id: input.customer_id, subscription_id: input.subscription_id },
      subscription: { id: input.subscription_id, customer_id: input.customer_id },
      inserted: true
    };
    this.sagas.set(input.renewal_id, saga);
    return { ...saga };
  }
  async get(id) { return this.sagas.has(id) ? { ...this.sagas.get(id) } : null; }
  async transition(id, { from, to, reason = null, failure = null, nextRetryAt = null }) {
    const saga = this.sagas.get(id);
    assert.equal(saga.state, from, 'compare-and-set deve proteger concorrência');
    transitionRenewal(from, to);
    saga.state = to;
    saga.revision += 1;
    if (to === 'PROCESSING') saga.attempts += 1;
    saga.last_error = reason;
    saga.failure_class = failure?.class || null;
    saga.next_retry_at = nextRetryAt;
    return { ...saga };
  }
  async complete(id, { providerExpiration }) {
    const saga = this.sagas.get(id);
    assert.equal(saga.state, 'VERIFYING');
    saga.state = 'COMPLETED';
    saga.provider_expiration = providerExpiration;
    saga.completed_at = '2026-08-23T12:00:00.000Z';
    saga.revision += 1;
    return { ...saga };
  }
}

function payment(overrides = {}) {
  return {
    id: IDS.payment, status: 'CONFIRMED', amount_cents: 3000,
    customer_id: IDS.customer, subscription_id: IDS.subscription, ...overrides
  };
}

function createOrchestrator({ repository = new MemoryRenewalRepository(), script = {} } = {}) {
  const provider = new FakeProvisioningProvider({
    renewAccount: { status: 'SUCCESS' },
    getExpiration: { status: 'SUCCESS', expiration: '2026-09-30' },
    ...script
  });
  return {
    repository, provider,
    orchestrator: new RenewalOrchestrator({
      repository, provider, now: () => new Date('2026-08-23T12:00:00.000Z')
    })
  };
}

async function start(orchestrator, overrides = {}) {
  return orchestrator.start({
    renewalId: IDS.renewal, customerId: IDS.customer, subscriptionId: IDS.subscription,
    payment: payment(), previousExpiration: '2026-08-31', requestedExtensionMonths: 1,
    requestedBy: { type: 'CUSTOMER', id: IDS.customer }, correlationId: IDS.correlation,
    expectedAmountCents: 3000, ...overrides
  });
}

test('política de data centralizada preserva fim do mês', () => {
  assert.equal(expirationForPlan('2026-01-31', { durationMonths: 1 }), '2026-02-28');
  assert.equal(expirationForPlan('2026-08-31', { durationMonths: 1 }), '2026-09-30');
  assert.equal(expirationForPlan('2026-08-31', { durationMonths: 12 }), '2027-08-31');
});

test('state machine cobre requested, waiting, ready, processing, verifying e completed', () => {
  assert.equal(transitionRenewal('REQUESTED', 'WAITING_PAYMENT').changed, true);
  assert.equal(transitionRenewal('WAITING_PAYMENT', 'READY').changed, true);
  assert.equal(transitionRenewal('READY', 'PROCESSING').changed, true);
  assert.equal(transitionRenewal('PROCESSING', 'VERIFYING').changed, true);
  assert.equal(transitionRenewal('VERIFYING', 'COMPLETED').changed, true);
  assert.throws(() => transitionRenewal('COMPLETED', 'PROCESSING'), /não permitida/);
});

test('fluxo feliz só conclui depois da verificação independente', async () => {
  const { orchestrator, provider } = createOrchestrator();
  await start(orchestrator);
  const result = await orchestrator.run(IDS.renewal);
  assert.equal(result.saga.state, 'COMPLETED');
  assert.equal(result.verification.verified, true);
  assert.deepEqual(provider.calls.map((call) => call.operation), ['renewAccount', 'getExpiration']);
});

test('replay de renovação concluída não amplia validade novamente', async () => {
  const { orchestrator, provider } = createOrchestrator();
  await start(orchestrator);
  await orchestrator.run(IDS.renewal);
  const replay = await orchestrator.run(IDS.renewal);
  assert.equal(replay.duplicate, true);
  assert.equal(provider.calls.filter((call) => call.operation === 'renewAccount').length, 1);
});

test('duas solicitações com o mesmo pagamento convergem para uma saga', async () => {
  const { orchestrator, repository } = createOrchestrator();
  const first = await start(orchestrator);
  const duplicate = await start(orchestrator, { renewalId: '60000000-0000-4000-8000-000000000006' });
  assert.equal(first.renewal_id, duplicate.renewal_id);
  assert.equal(repository.sagas.size, 1);
});

test('pagamento insuficiente, cliente e assinatura errados bloqueiam', async () => {
  const { orchestrator } = createOrchestrator();
  await assert.rejects(start(orchestrator, { payment: payment({ amount_cents: 1000 }) }), /PAYMENT_REVIEW_REQUIRED/);
  await assert.rejects(start(orchestrator, { payment: payment({ customer_id: 'customer-b' }) }), /PAYMENT_CUSTOMER_MISMATCH/);
  await assert.rejects(start(orchestrator, { payment: payment({ subscription_id: 'subscription-b' }) }), /PAYMENT_SUBSCRIPTION_MISMATCH/);
});

test('restart em PROCESSING retoma por verificação sem repetir renewAccount', async () => {
  const repository = new MemoryRenewalRepository();
  const first = createOrchestrator({ repository });
  await start(first.orchestrator);
  await repository.transition(IDS.renewal, { from: 'READY', to: 'PROCESSING' });
  const afterRestart = createOrchestrator({ repository });
  const result = await afterRestart.orchestrator.run(IDS.renewal);
  assert.equal(result.saga.state, 'COMPLETED');
  assert.deepEqual(afterRestart.provider.calls.map((call) => call.operation), ['getExpiration']);
});

test('timeout agenda retry; CAPTCHA pausa para ação humana; falha permanente encerra', async () => {
  for (const [error, expected] of [
    [Object.assign(new Error('timeout'), { code: 'TIMEOUT' }), 'RETRY_SCHEDULED'],
    [Object.assign(new Error('captcha'), { code: 'CAPTCHA' }), 'HUMAN_ACTION_REQUIRED'],
    [Object.assign(new Error('not found'), { code: 'NOT_FOUND' }), 'FAILED']
  ]) {
    const repository = new MemoryRenewalRepository();
    const { orchestrator } = createOrchestrator({ repository, script: { renewAccount: error } });
    await start(orchestrator);
    const result = await orchestrator.run(IDS.renewal);
    assert.equal(result.saga.state, expected);
  }
});

test('mismatch de verificação nunca conclui renovação', async () => {
  const { orchestrator } = createOrchestrator({
    script: { getExpiration: { status: 'SUCCESS', expiration: '2026-09-29' } }
  });
  await start(orchestrator);
  const result = await orchestrator.run(IDS.renewal);
  assert.equal(result.saga.state, 'HUMAN_ACTION_REQUIRED');
  assert.equal(result.verification.code, 'EXPIRATION_MISMATCH');
});

test('invariante exige confirmação e verificação para estado completed', () => {
  assert.throws(() => assertRenewalInvariants({
    renewal: { customer_id: IDS.customer, subscription_id: IDS.subscription, state: 'COMPLETED' },
    payment: payment(), subscription: { id: IDS.subscription, customer_id: IDS.customer }
  }), /VERIFICATION_REQUIRED/);
});
