import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FakeProvisioningProvider,
  provisioningDecision,
  verifyExpiration
} from '../src/core/provisioning-orchestrator.js';
import { ProvisioningOrchestrator } from '../src/services/provisioning-orchestration.js';

test('fake provider isola success, lookup, status e expiration', async () => {
  const provider = new FakeProvisioningProvider({
    lookupAccount: { status: 'SUCCESS', provider_reference: 'fake-1' },
    getStatus: { status: 'SUCCESS' },
    getExpiration: { status: 'SUCCESS', expiration: '2026-09-30' },
    renewAccount: { status: 'SUCCESS' }
  });
  assert.equal((await provider.lookupAccount({})).provider_reference, 'fake-1');
  assert.equal((await provider.getStatus({})).status, 'SUCCESS');
  assert.equal((await provider.getExpiration({})).expiration, '2026-09-30');
  assert.equal((await provider.renewAccount({})).status, 'SUCCESS');
});

test('provider results classificam retry, auth, human e permanent', () => {
  assert.deepEqual(provisioningDecision({ status: 'SUCCESS' }), { next: 'VERIFYING', retry: false });
  assert.deepEqual(provisioningDecision({ status: 'TEMPORARY_FAILURE' }), { next: 'RETRY_SCHEDULED', retry: true });
  assert.equal(provisioningDecision({ status: 'AUTH_REQUIRED' }).next, 'HUMAN_ACTION_REQUIRED');
  assert.equal(provisioningDecision({ status: 'HUMAN_ACTION_REQUIRED' }).next, 'HUMAN_ACTION_REQUIRED');
  assert.equal(provisioningDecision({ status: 'PERMANENT_FAILURE' }).next, 'FAILED');
});

test('verificação exige extensão exata e independente', () => {
  assert.equal(verifyExpiration({
    previousExpiration: '2026-08-31', expectedExpiration: '2026-09-30', providerExpiration: '2026-09-30'
  }).verified, true);
  assert.equal(verifyExpiration({
    previousExpiration: '2026-08-31', expectedExpiration: '2026-09-30', providerExpiration: '2026-09-29'
  }).code, 'EXPIRATION_MISMATCH');
  assert.equal(verifyExpiration({
    previousExpiration: '2026-08-31', expectedExpiration: '2026-09-30', providerExpiration: '2026-08-31'
  }).verified, false);
});

test('ProvisioningOrchestrator separa comando do provider e verificação', async () => {
  const provider = new FakeProvisioningProvider({
    renewAccount: { status: 'SUCCESS' },
    getExpiration: { status: 'SUCCESS', expiration: '2026-09-30' }
  });
  const orchestrator = new ProvisioningOrchestrator({ provider });
  const requested = await orchestrator.requestRenewal({
    renewal_id: '10000000-0000-4000-8000-000000000001',
    customer_id: '20000000-0000-4000-8000-000000000002',
    subscription_id: '30000000-0000-4000-8000-000000000003',
    expected_expiration: '2026-09-30',
    correlation_id: '40000000-0000-4000-8000-000000000004',
    causation_id: null
  });
  assert.equal(requested.operation.orchestration_state, 'VERIFYING');
  const verification = await orchestrator.verifyRenewal({
    operation: requested.operation,
    previous_expiration: '2026-08-31',
    expected_expiration: '2026-09-30'
  });
  assert.equal(verification.verified, true);
  assert.deepEqual(provider.calls.map((call) => call.operation), ['renewAccount', 'getExpiration']);
});
