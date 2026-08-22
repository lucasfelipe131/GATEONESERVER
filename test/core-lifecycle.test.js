import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMER_LIFECYCLE_TRANSITIONS,
  lifecycleFromLegacyStatus,
  transitionCustomerLifecycle
} from '../src/core/lifecycle.js';
import { identityResolution, resolveCustomerIdentity } from '../src/core/identity.js';
import { renewalExecutionDecision } from '../src/core/renewal.js';

test('mapeia estados legados sem criar conceito duplicado', () => {
  assert.equal(lifecycleFromLegacyStatus('lead'), 'LEAD');
  assert.equal(lifecycleFromLegacyStatus('active'), 'ACTIVE');
  assert.equal(lifecycleFromLegacyStatus('late'), 'PAST_DUE');
  assert.equal(lifecycleFromLegacyStatus('suspended'), 'BLOCKED');
  assert.equal(lifecycleFromLegacyStatus('cancelled'), 'CHURNED');
});

test('WAITING_PAYMENT não vira ACTIVE apenas por pagamento confirmado', () => {
  const denied = transitionCustomerLifecycle({
    current: 'WAITING_PAYMENT',
    next: 'ACTIVE',
    event: 'PAYMENT_CONFIRMED'
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'CONDITION_NOT_MET');
  assert.deepEqual(denied.required_events, ['SUBSCRIPTION_ACTIVATED']);
});

test('renovação só reativa o cliente após conclusão operacional', () => {
  assert.equal(transitionCustomerLifecycle({
    current: 'RENEWAL_PENDING',
    next: 'ACTIVE',
    event: 'RENEWAL_COMPLETED'
  }).allowed, true);
  assert.equal(transitionCustomerLifecycle({
    current: 'RENEWAL_PENDING',
    next: 'ACTIVE',
    event: 'PAYMENT_CONFIRMED'
  }).allowed, false);
});

test('rejeita transição sem caminho explícito', () => {
  const decision = transitionCustomerLifecycle({
    current: 'LEAD',
    next: 'ACTIVE',
    event: 'SUBSCRIPTION_ACTIVATED'
  });
  assert.deepEqual(decision, {
    allowed: false,
    code: 'INVALID_TRANSITION',
    reason: 'PATH_NOT_ALLOWED'
  });
  assert.equal(Object.hasOwn(CUSTOMER_LIFECYCLE_TRANSITIONS.LEAD, 'ACTIVE'), false);
});

test('resolução de identidade retorna MATCHED, AMBIGUOUS ou NOT_FOUND', () => {
  const candidates = [
    { customer_id: 'customer-a', identity_type: 'LOGIN', provider: 'bitpanel', external_id: 'Lucas.01' },
    { customer_id: 'customer-b', identity_type: 'LOGIN', provider: 'bitpanel', external_id: 'shared' },
    { customer_id: 'customer-c', identity_type: 'LOGIN', provider: 'bitpanel', external_id: 'shared' }
  ];
  assert.deepEqual(resolveCustomerIdentity(candidates, {
    type: 'LOGIN', provider: 'bitpanel', value: 'lucas.01'
  }), { status: 'MATCHED', customer_id: 'customer-a' });
  assert.deepEqual(resolveCustomerIdentity(candidates, {
    type: 'LOGIN', provider: 'bitpanel', value: 'SHARED'
  }), { status: 'AMBIGUOUS', customer_id: null, candidate_count: 2 });
  assert.deepEqual(identityResolution([]), { status: 'NOT_FOUND', customer_id: null });
});

test('renovação duplicada concluída não volta ao provider', () => {
  assert.deepEqual(renewalExecutionDecision({
    coreStatus: 'COMPLETED',
    legacyStatus: 'completed',
    paymentStatus: 'paid',
    approvedAt: '2026-08-22T12:00:00.000Z',
    requiresApproval: true
  }), {
    allowed: false,
    duplicate: true,
    code: 'RENEWAL_ALREADY_COMPLETED'
  });
  assert.equal(renewalExecutionDecision({
    coreStatus: 'READY',
    legacyStatus: 'awaiting_approval',
    paymentStatus: 'sent',
    approvedAt: null,
    requiresApproval: false
  }).code, 'PAYMENT_NOT_CONFIRMED');
});
