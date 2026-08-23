import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  authorizationFailure,
  CAPABILITIES,
  capabilitiesForRole,
  hasCapability,
  isStepUpValid,
  isTrustedMutationOrigin
} from '../src/authorization.js';

test('admin recebe todas as capacidades e operator permanece limitado', () => {
  const admin = capabilitiesForRole('admin');
  const operator = capabilitiesForRole('operator');
  assert.equal(admin.size, Object.keys(CAPABILITIES).length);
  assert.equal(operator.has(CAPABILITIES.CUSTOMER_WRITE), true);
  assert.equal(operator.has(CAPABILITIES.BILLING_READ), true);
  assert.equal(operator.has(CAPABILITIES.CUSTOMER_DELETE), false);
  assert.equal(operator.has(CAPABILITIES.BILLING_MARK_PAID), false);
  assert.equal(operator.has(CAPABILITIES.PROVISIONING_READ), false);
  assert.equal(operator.has(CAPABILITIES.SETTINGS_WRITE), false);
  assert.equal(operator.has(CAPABILITIES.INTEGRATION_MANAGE), false);
});

test('papel desconhecido é default deny', () => {
  assert.equal(capabilitiesForRole('owner').size, 0);
  assert.equal(hasCapability({ role: 'owner' }, CAPABILITIES.DASHBOARD_READ), false);
  assert.equal(hasCapability(null, CAPABILITIES.DASHBOARD_READ), false);
});

test('step-up só é válido antes da expiração', () => {
  const now = new Date('2026-08-22T15:00:00.000Z');
  const capability = CAPABILITIES.CUSTOMER_DELETE;
  assert.equal(isStepUpValid({
    stepUpUntil: '2026-08-22T15:01:00.000Z',
    stepUpCapability: capability
  }, capability, now), true);
  assert.equal(isStepUpValid({
    stepUpUntil: '2026-08-22T15:00:00.000Z',
    stepUpCapability: capability
  }, capability, now), false);
  assert.equal(isStepUpValid({
    stepUpUntil: '2026-08-22T15:01:00.000Z',
    stepUpCapability: CAPABILITIES.BILLING_MARK_PAID
  }, capability, now), false);
  assert.equal(isStepUpValid({
    stepUpUntil: 'inválido',
    stepUpCapability: capability
  }, capability, now), false);
  assert.equal(isStepUpValid(null, capability, now), false);
});

test('decisão negativa distingue capability ausente de step-up ausente', () => {
  const future = {
    stepUpUntil: '2999-01-01T00:00:00.000Z',
    stepUpCapability: CAPABILITIES.CUSTOMER_DELETE
  };
  assert.deepEqual(
    authorizationFailure(
      { role: 'operator' },
      future,
      CAPABILITIES.CUSTOMER_DELETE,
      { stepUp: true }
    ),
    { statusCode: 403, code: 'CAPABILITY_DENIED' }
  );
  assert.deepEqual(
    authorizationFailure(
      { role: 'admin' },
      null,
      CAPABILITIES.CUSTOMER_DELETE,
      { stepUp: true }
    ),
    { statusCode: 403, code: 'STEP_UP_REQUIRED' }
  );
  assert.equal(
    authorizationFailure(
      { role: 'admin' },
      future,
      CAPABILITIES.CUSTOMER_DELETE,
      { stepUp: true }
    ),
    null
  );
});

test('mutação aceita apenas a origem administrativa esperada', () => {
  const base = {
    protocol: 'https',
    headers: { host: 'gate.example.com', origin: 'https://gate.example.com' }
  };
  assert.equal(isTrustedMutationOrigin(base), true);
  assert.equal(
    isTrustedMutationOrigin({ ...base, headers: { ...base.headers, origin: 'https://evil.example' } }),
    false
  );
  assert.equal(
    isTrustedMutationOrigin({ ...base, headers: { host: 'gate.example.com', 'sec-fetch-site': 'cross-site' } }),
    false
  );
  assert.equal(
    isTrustedMutationOrigin({ ...base, headers: { host: 'internal', origin: 'https://public.example' } }, 'https://public.example/app'),
    true
  );
});

test('todas as rotas administrativas usam protect com capability explícita', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const routePattern = /app\.(?:get|post|put|patch|delete)\(\s*['"]\/api\/admin\//g;
  const routes = [...source.matchAll(routePattern)];
  assert.ok(routes.length >= 30, `Inventário inesperado de rotas admin: ${routes.length}`);
  for (const route of routes) {
    const declaration = source.slice(route.index, route.index + 500);
    assert.match(declaration, /preHandler:\s*protect\(CAPABILITIES\./);
  }
  assert.doesNotMatch(source, /\/api\/admin[\s\S]{0,250}preHandler:\s*requireAuth/);
});

test('rotas financeiras e destrutivas exigem step-up', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  for (const declaration of [
    "app.delete('/api/admin/customers/:id'",
    "app.post('/api/admin/charges/:id/mark-paid'",
    "app.post('/api/admin/renewals/:id/approve'",
    "'/api/admin/integrations/mercadopago/activate'"
  ]) {
    const start = source.indexOf(declaration);
    assert.notEqual(start, -1, `Declaração não encontrada: ${declaration}`);
    assert.match(source.slice(start, start + 500), /stepUp:\s*true/);
  }
});

test('painel solicita step-up e repete a ação sem armazenar a senha', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /body\.code === 'STEP_UP_REQUIRED'/);
  assert.match(source, /\/api\/auth\/step-up/);
  assert.match(source, /capability: body\.capability/);
  assert.doesNotMatch(source, /state\.(?:password|adminPassword|stepUpPassword)/);
});
