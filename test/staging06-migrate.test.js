import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStaging06Migration, assertStaging06History } from '../scripts/staging06-migrate.js';

const env = { SUPPORT_AGENT_ENABLED: 'true', PROVIDER_MODE: 'fake-only', NODE_ENV: 'test',
  GATE_ENVIRONMENT: 'staging-055', GATE_TEST_MODE: 'true', GLOBAL_PAUSE: 'true',
  RAILWAY_PROJECT_ID: 'a59164b2-217a-4570-9e7c-e4dff16b3dab',
  RAILWAY_ENVIRONMENT_ID: '413bd932-e13e-4196-a66c-e55c98bbdd8b',
  RAILWAY_SERVICE_ID: '13d818b3-c24e-47c8-a617-4a7ae8ca21f3',
  PAYMENT_MODE: 'simulation', WHATSAPP_MODE: 'simulation', BITPANEL_MODE: 'disabled',
  AI_ADMIN_ENABLED: 'false', AI_WHATSAPP_ENABLED: 'false', TELEGRAM_SYNC_ENABLED: 'false',
  GATE_DATABASE_ROLE: 'SOURCE', OUTBOX_DISPATCHER_ENABLED: 'false', SEED_DEMO: 'false',
  DATABASE_URL: 'postgresql://railway:synthetic@postgres.railway.internal:5432/railway' };
test('staging06 migration rejects a wrong project, service, database or live mode before connecting', () => {
  assert.equal(assertStaging06Migration(env).hostname, 'postgres.railway.internal');
  for (const key of Object.keys(env))
    assert.throws(() => assertStaging06Migration({ ...env, [key]: 'wrong' }), undefined, key);
  assert.throws(() => assertStaging06Migration({ ...env, GATE_ENVIRONMENT: 'test' }));
  for (const DATABASE_URL of ['postgresql://railway:x@qa06-postgres.railway.internal/railway',
    'postgresql://railway:x@postgres.railway.internal/railway?host=production',
    'postgresql://railway:x@external.example/railway'])
    assert.throws(() => assertStaging06Migration({ ...env, DATABASE_URL }));
});
test('staging06 migration accepts only the existing 0000-0005 history and additive 0006', () => {
  const applied = ['0000', '0001', '0002', '0003', '0004', '0005'].map(version => ({ version }));
  assert.doesNotThrow(() => assertStaging06History({ applied,
    pending: [{ name: '0006_support_exception_command_center.sql' }] }));
  assert.doesNotThrow(() => assertStaging06History({ applied: [...applied, { version: '0006' }], pending: [] }));
  assert.throws(() => assertStaging06History({ applied: [], pending: [] }));
  assert.throws(() => assertStaging06History({ applied, pending: [{ name: '0007_other.sql' }] }));
});
