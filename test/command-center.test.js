import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { fixture } from '../scripts/support-fixture.js';
import {
  MemoryCommandCenter,
  registerCommandCenter,
  supportMetrics,
} from '../src/services/command-center.js';
import {
  authorizationFailure,
  isTrustedMutationOrigin,
} from '../src/authorization.js';

async function runtime() {
  const f = await fixture({ known: false });
  await f.run();
  const readModel = new MemoryCommandCenter({
    repository: f.repository,
    context: f.context,
    decisions: f.decisions,
  });
  const app = Fastify();
  const protect =
    (capability, { stepUp = false, mutation = false } = {}) =>
    async (req, reply) => {
      if (!req.headers['x-test-role'])
        return reply.code(401).send({ code: 'AUTH_REQUIRED' });
      req.user = { id: 'synthetic-admin', role: req.headers['x-test-role'] };
      if (mutation && !isTrustedMutationOrigin(req, 'http://localhost'))
        return reply.code(403).send({ code: 'UNTRUSTED_ORIGIN' });
      const session = req.headers['x-test-step-up']
        ? {
            stepUpCapability: capability,
            stepUpUntil: new Date(Date.now() + 60000).toISOString(),
          }
        : {};
      const failure = authorizationFailure(req.user, session, capability, {
        stepUp,
      });
      if (failure) return reply.code(failure.statusCode).send(failure);
    };
  registerCommandCenter(app, { readModel, operations: f.operations, protect });
  return { f, app, readModel };
}
for (const endpoint of [
  'summary',
  'metrics',
  'activity',
  'exceptions',
  'cases',
  'conversations',
])
  test(`phase6 Command Center ${endpoint} read model endpoint`, async () => {
    const { app } = await runtime();
    try {
      const r = await app.inject({
        url: `/api/admin/command-center/${endpoint}`,
        headers: { 'x-test-role': 'operator' },
      });
      assert.equal(r.statusCode, 200);
      assert.ok(r.json());
    } finally {
      await app.close();
    }
  });
test('phase6 endpoints enforce authentication, RBAC and capability-scoped step-up', async () => {
  const { app, f } = await runtime();
  const e = [...f.repository.tables.exceptions.values()][0];
  const url = `/api/admin/command-center/customers/${f.a}/exceptions/${e.id}/resolve`;
  try {
    assert.equal(
      (await app.inject('/api/admin/command-center/summary')).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'x-test-role': 'operator' },
        })
      ).json().code,
      'CAPABILITY_DENIED',
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'x-test-role': 'admin' },
        })
      ).json().code,
      'STEP_UP_REQUIRED',
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: {
            'x-test-role': 'admin',
            'x-test-step-up': 'true',
            origin: 'https://untrusted.invalid',
          },
        })
      ).json().code,
      'UNTRUSTED_ORIGIN',
    );
    const r = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-test-role': 'admin', 'x-test-step-up': 'true' },
      payload: {
        note: 'Resultado confirmado com cliente sintético.',
        result: 'VERIFIED',
      },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().status, 'RESOLVED');
  } finally {
    await app.close();
  }
});
test('phase6 exception detail and customer context deny mismatched customer', async () => {
  const { app, f } = await runtime();
  const e = [...f.repository.tables.exceptions.values()][0];
  try {
    assert.equal(
      (
        await app.inject({
          url: `/api/admin/command-center/customers/${f.b}/exceptions/${e.id}`,
          headers: { 'x-test-role': 'admin' },
        })
      ).statusCode,
      404,
    );
    const c = await app.inject({
      url: `/api/admin/command-center/customers/${f.a}`,
      headers: { 'x-test-role': 'admin' },
    });
    assert.equal(c.json().customer360.contract, 'Customer360.v1');
  } finally {
    await app.close();
  }
});
test('phase6 list filters and pagination are bounded and validated', async () => {
  const { app, f } = await runtime();
  await f.run('não está funcionando', f.b);
  try {
    const r = await app.inject({
      url: '/api/admin/command-center/exceptions?limit=1',
      headers: { 'x-test-role': 'admin' },
    });
    assert.equal(r.json().items.length, 1);
    assert.equal(r.json().has_more, true);
    assert.equal(
      (
        await app.inject({
          url: '/api/admin/command-center/exceptions?limit=9999',
          headers: { 'x-test-role': 'admin' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/admin/command-center/exceptions?severity=CRITICAL',
          headers: { 'x-test-role': 'admin' },
        })
      ).json().items.length,
      0,
    );
  } finally {
    await app.close();
  }
});
test('phase6 eligible failures remain in autonomy denominator; no data is null not 100%', () => {
  const m = supportMetrics([
    {
      automation_eligible: true,
      status: 'RESOLVED',
      verification_result: 'VERIFIED',
    },
    {
      automation_eligible: true,
      status: 'HUMAN_REQUIRED',
      human_intervention: true,
    },
  ]);
  assert.equal(m.autonomous_resolution_rate.value, 0.5);
  assert.equal(m.autonomous_resolution_rate.denominator, 2);
  assert.equal(supportMetrics([]).autonomous_resolution_rate.value, null);
});
test('phase6 component failure does not disable other endpoints', async () => {
  const { app, readModel } = await runtime();
  readModel.metrics = async () => {
    throw new Error('SIMULATED_READ_FAILURE');
  };
  try {
    assert.equal(
      (
        await app.inject({
          url: '/api/admin/command-center/metrics',
          headers: { 'x-test-role': 'admin' },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/admin/command-center/summary',
          headers: { 'x-test-role': 'admin' },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});
test('phase6 UI structural coverage: pages, responsive breakpoints, errors, empty states and no unsafe generic admin button', async () => {
  const html = await readFile(
    new URL('../public/index.html', import.meta.url),
    'utf8',
  );
  const js = await readFile(
    new URL('../public/command-center.js', import.meta.url),
    'utf8',
  );
  const css = await readFile(
    new URL('../public/command-center.css', import.meta.url),
    'utf8',
  );
  for (const id of [...js.matchAll(/find\('([A-Za-z][\w-]*)'\)/g)]
    .map((m) => m[1])
    .filter((i) => !['ccHumanNote', 'ccActionResult'].includes(i)))
    assert.ok(html.includes(`id="${id}"`), id);
  assert.match(js, /Nenhuma solicitação precisa da sua atenção agora/);
  assert.match(js, /As outras áreas continuam disponíveis/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /@media\(max-width:1100px\)/);
  assert.doesNotMatch(
    js,
    /arbitrary|executeShell|runSql|innerHTML\s*=\s*e\.summary/,
  );
});
test('phase6 incident candidate counts distinct customers in rolling 15-minute window', async () => {
  const f = await fixture({ known: false });
  const context = await f.context(f.a);
  for (let i = 0; i < 20; i++) {
    const id = randomUUID();
    await f.operations.prepare({
      customer_id: id,
      context: { ...context, customer_id: id },
      text: 'não está funcionando',
      intent: 'SUPPORT_REQUEST',
      conversation_id: randomUUID(),
      context_snapshot_id: randomUUID(),
      correlation_id: randomUUID(),
      idempotency_key: randomUUID(),
    });
  }
  assert.equal(f.repository.tables.incidents.size, 1);
  assert.equal(
    [...f.repository.tables.incidents.values()][0].distinct_customers,
    20,
  );
});
