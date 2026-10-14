import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticRenewalDecision } from '../src/services/automatic-renewal-policy.js';

const NOW = '2026-10-12T12:00:00.000Z';
const ACTIVATED = '2026-10-12T10:00:00.000Z';
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
function fixture() {
  return {
    now: NOW,
    policy: { enabled: true, activatedAt: ACTIVATED, validatedAt: '2026-10-12T09:00:00Z', provider: 'mercadopago', operation: 'renew',
      validatedSource: 'https://bitpanel.vip/list', maxCreditsPerRenewal: 12,
      plans: { monthly: { durationMonths: 1, priceCents: 3000, creditCost: 1 }, quarterly: { durationMonths: 3, priceCents: 8500, creditCost: 3 },
        semiannual: { durationMonths: 6, priceCents: 15000, creditCost: 6 }, annual: { durationMonths: 12, priceCents: 27000, creditCost: 12 } } },
    renewal: { id: id(1), customer_id: id(2), subscription_id: id(3), payment_id: id(4), charge_id: id(5), status: 'awaiting_approval',
      core_status: 'READY', attempts: 0, charge_stage: 'manual', charge_status: 'paid', charge_amount_cents: 3000, plan_price_cents: 3000,
      plan_code: 'monthly', duration_months: 1, requested_extension_months: 1, bitpanel_list_id: '321', bitpanel_reference: 'cliente',
      bitpanel_owner: 'Gate One Pro Server', automation_eligible: true },
    payment: { id: id(4), customer_id: id(2), subscription_id: id(3), charge_id: id(5), provider: 'mercadopago', status: 'CONFIRMED',
      reconciliation_status: 'MATCHED', amount_cents: 3000, currency: 'BRL', external_payment_id: '12345678', confirmed_at: '2026-10-12T11:00:00Z',
      provider_payload: { date_approved:'2026-10-12T11:00:00Z' } },
    customer: { id: id(2), subscription_id: id(3), bitpanel_list_id: '321', bitpanel_reference: 'cliente', bitpanel_owner: 'Gate One Pro Server', automation_eligible: true }
  };
}
const decide = change => { const input = fixture(); change(input); return automaticRenewalDecision(input); };
const expectDenied = (change, code) => assert.deepEqual(decide(change), { allowed: false, requiresApproval: true, code, creditCost: null });

test('somente pagamento confirmado consistente permite renovação e retorna custo aprovado', () => {
  assert.deepEqual(automaticRenewalDecision(fixture()), { allowed: true, requiresApproval: false, code: 'AUTO_RENEWAL_ALLOWED', creditCost: 1 });
  assert.equal(decide(input => { input.renewal.status = 'queued'; }).allowed, true);
  for (const plan of ['quarterly', 'semiannual', 'annual']) {
    const result = decide(input => {
      const mapping = input.policy.plans[plan];
      Object.assign(input.renewal, { plan_code: plan, duration_months: mapping.durationMonths, requested_extension_months: mapping.durationMonths,
        plan_price_cents: mapping.priceCents, charge_amount_cents: mapping.priceCents });
      input.payment.amount_cents = mapping.priceCents;
    });
    assert.equal(result.allowed, true);
  }
});

test('política desabilitada ou não validada sempre exige aprovação', () => {
  assert.deepEqual(automaticRenewalDecision(), { allowed: false, requiresApproval: true, code: 'AUTO_RENEWAL_DISABLED', creditCost: null });
  for (const enabled of [false, 'true', 1, undefined]) expectDenied(input => { input.policy.enabled = enabled; }, 'AUTO_RENEWAL_DISABLED');
  for (const value of [null, '', 'invalid', '2026-10-13T00:00:00Z']) {
    expectDenied(input => { input.policy.validatedAt = value; }, 'AUTO_RENEWAL_POLICY_INVALID');
    expectDenied(input => { input.policy.activatedAt = value; }, 'AUTO_RENEWAL_POLICY_INVALID');
  }
  expectDenied(input => { input.policy.provider = 'fake'; }, 'AUTO_RENEWAL_POLICY_INVALID');
  expectDenied(input => { input.policy.operation = 'provision'; }, 'AUTO_RENEWAL_POLICY_INVALID');
  expectDenied(input => { input.policy.validatedSource = 'https://bitpanel.vip.evil.com/list'; }, 'AUTO_RENEWAL_POLICY_INVALID');
  expectDenied(input => { input.policy.validatedSource = 'https://user:secret@bitpanel.vip/list'; }, 'AUTO_RENEWAL_POLICY_INVALID');
});

test('prazo só expira se informado, sem expiração presumida da autorização', () => {
  assert.equal(decide(input => { input.policy.validatedAt = '2026-01-01T00:00:00Z'; }).allowed, true);
  assert.equal(decide(input => { input.policy.validUntil = '2026-10-13T00:00:00Z'; }).allowed, true);
  expectDenied(input => { input.policy.validUntil = NOW; }, 'AUTO_RENEWAL_POLICY_EXPIRED');
  expectDenied(input => { input.policy.validUntil = '2026-10-12T10:30:00Z'; }, 'AUTO_RENEWAL_POLICY_EXPIRED');
  expectDenied(input => { input.policy.validUntil = 'invalid'; }, 'AUTO_RENEWAL_POLICY_INVALID');
});

test('comprovante, declaração do cliente, pagamento simulado ou incompleto não autorizam', () => {
  for (const status of ['approved', 'PENDING', 'FAILED', 'REFUNDED', 'CUSTOMER_REPORTED', undefined])
    expectDenied(input => { input.payment.status = status; }, 'AUTO_RENEWAL_PAYMENT_UNVERIFIED');
  for (const patch of [{ source: 'WHATSAPP' }, { source: 'CUSTOMER_PROOF' }, { provider: 'fake' }, { reconciliation_status: 'REQUIRES_REVIEW' },
    { review_reason: 'AMOUNT_MISMATCH' }, { currency: 'USD' }, { external_payment_id: 'SIM-123' }, { simulated: true },
    { live_mode: false }, { provider_verified: false }, { provider_payload: { simulated: true } }, { confirmed_at: null },
    { confirmed_at: '2026-10-13T00:00:00Z' }])
    expectDenied(input => { Object.assign(input.payment, patch); }, 'AUTO_RENEWAL_PAYMENT_UNVERIFIED');
});

test('pagamento anterior à ativação não reativa trabalho histórico', () => {
  expectDenied(input => { input.payment.confirmed_at = '2026-10-12T09:59:59.999Z'; }, 'AUTO_RENEWAL_PAYMENT_BEFORE_ACTIVATION');
  assert.equal(decide(input => { input.payment.confirmed_at = ACTIVATED; input.payment.provider_payload.date_approved=ACTIVATED; }).allowed, true);
  expectDenied(input => { input.payment.provider_payload.date_approved = '2026-10-12T09:59:59.999Z'; }, 'AUTO_RENEWAL_PAYMENT_BEFORE_ACTIVATION');
  for(const value of [null,'invalid','2026-10-13T00:00:00Z'])
    expectDenied(input => { input.payment.provider_payload.date_approved=value; }, 'AUTO_RENEWAL_PAYMENT_UNVERIFIED');
});

test('IDs e cadastro devem ligar pagamento, cobrança, cliente, assinatura e lista exatos', () => {
  for (const key of ['customer_id', 'subscription_id', 'payment_id', 'charge_id'])
    expectDenied(input => { input.renewal[key] = id(99); }, 'AUTO_RENEWAL_SUBJECT_MISMATCH');
  for (const key of ['customer_id', 'subscription_id', 'id', 'charge_id'])
    expectDenied(input => { input.payment[key] = id(99); }, 'AUTO_RENEWAL_SUBJECT_MISMATCH');
  for (const patch of [{ id: id(99) }, { subscription_id: id(99) }, { subscription_customer_id: id(99) },
    { bitpanel_reference: 'outro-cliente' }, { bitpanel_list_id: '999' }])
    expectDenied(input => { Object.assign(input.customer, patch); }, 'AUTO_RENEWAL_SUBJECT_MISMATCH');
});

test('somente lista existente e propriedade Gate One permitem automação', () => {
  for (const patch of [{ charge_stage: 'new_sale' }, { operation: 'provision' }, { bitpanel_list_id: null },
    { bitpanel_list_id: '0' }, { bitpanel_reference: '' }])
    expectDenied(input => { Object.assign(input.renewal, patch); }, 'AUTO_RENEWAL_NOT_RENEWAL');
  for (const patch of [{ automation_eligible: false }, { automation_eligible: 'true' }, { bitpanel_owner: 'outro revendedor' }]) {
    expectDenied(input => { Object.assign(input.customer, patch); }, 'AUTO_RENEWAL_CUSTOMER_INELIGIBLE');
    expectDenied(input => { Object.assign(input.renewal, patch); }, 'AUTO_RENEWAL_CUSTOMER_INELIGIBLE');
  }
});

test('tentativas, processamento, falhas, conclusão e replay não são repetidos automaticamente', () => {
  for (const patch of [{ attempts: 1 }, { attempts: '0' }, { completed_at: NOW }, { processing_at: NOW }, { after_expiry: '2026-11-12' }, { duplicate: true }])
    expectDenied(input => { Object.assign(input.renewal, patch); }, 'AUTO_RENEWAL_ALREADY_ATTEMPTED');
  for (const status of ['running', 'failed', 'completed', 'cancelled', 'simulated', 'manual_review'])
    expectDenied(input => { input.renewal.status = status; }, 'AUTO_RENEWAL_STATE_BLOCKED');
  for (const core_status of ['PROCESSING', 'VERIFYING', 'COMPLETED', 'FAILED', 'WAITING_PAYMENT', null])
    expectDenied(input => { input.renewal.core_status = core_status; }, 'AUTO_RENEWAL_STATE_BLOCKED');
  expectDenied(input => { input.renewal.charge_status = 'sent'; }, 'AUTO_RENEWAL_STATE_BLOCKED');
});

test('plano, duração, cobrança, pagamento e custo precisam corresponder ao mapeamento validado', () => {
  expectDenied(input => { input.renewal.plan_code = 'unknown'; }, 'AUTO_RENEWAL_PLAN_MISMATCH');
  expectDenied(input => { input.renewal.plan_code = 'annual'; }, 'AUTO_RENEWAL_PLAN_MISMATCH');
  expectDenied(input => { input.renewal.duration_months = 3; }, 'AUTO_RENEWAL_PLAN_MISMATCH');
  expectDenied(input => { input.renewal.requested_extension_months = 3; }, 'AUTO_RENEWAL_PLAN_MISMATCH');
  for (const value of [undefined, 0, -1, 0.5, NaN, Infinity, '1'])
    expectDenied(input => { input.policy.plans.monthly.creditCost = value; }, 'AUTO_RENEWAL_MAPPING_REQUIRED');
  expectDenied(input => { delete input.policy.plans.monthly; }, 'AUTO_RENEWAL_MAPPING_REQUIRED');
  expectDenied(input => { input.policy.plans.monthly.creditCost = 13; }, 'AUTO_RENEWAL_CREDIT_LIMIT');
  for (const key of ['charge_amount_cents', 'plan_price_cents'])
    expectDenied(input => { input.renewal[key] = 2999; }, 'AUTO_RENEWAL_PRICE_MISMATCH');
  expectDenied(input => { input.payment.amount_cents = 2999; }, 'AUTO_RENEWAL_PRICE_MISMATCH');
});

test('decisão pura não altera entrada nem expõe segredos ou conteúdo do provedor', () => {
  const input = fixture(); input.payment.provider_payload = { password: 'private-secret' }; input.customer.password = 'private-secret';
  const before = JSON.stringify(input), result = automaticRenewalDecision(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(result).includes('private-secret'), false);
  assert.deepEqual(Object.keys(result), ['allowed', 'requiresApproval', 'code', 'creditCost']);
});
