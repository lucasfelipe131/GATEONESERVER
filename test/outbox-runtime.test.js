import test from 'node:test';
import assert from 'node:assert/strict';
import { startOutboxRuntime } from '../src/core/outbox-runtime.js';
import { startStagingOutbox } from '../src/services/staging-outbox.js';
import { validateStagingMigrations } from '../src/migrator-staging.js';
import { loadMigrations } from '../src/migrations.js';

test('dispatcher disabled by default without DB access', () => {
  assert.equal(startStagingOutbox({ env: {}, db: null }), null);
});
test('dispatcher fails closed outside fake staging', () => {
  assert.throws(() => startStagingOutbox({ env: { OUTBOX_DISPATCHER_ENABLED: 'true' }, db: null }), /GUARD/);
});

test('unified dispatcher rejects production environment before database access', () => {
  assert.throws(() => startStagingOutbox({ db: null, env: {
    OUTBOX_DISPATCHER_ENABLED: 'true', GATE_ENVIRONMENT: 'staging-unified', NODE_ENV: 'test',
    RAILWAY_PROJECT_ID: 'a0f107fe-acaf-459f-a640-38ef6010d1e5',
    RAILWAY_ENVIRONMENT_ID: '697f58fb-5084-4cb3-bd9a-ecdbc921b7bc',
    SUPPORT_AGENT_ENABLED: 'true', GATE_TEST_MODE: 'true', GLOBAL_PAUSE: 'true',
    PROVIDER_MODE: 'fake-only', PAYMENT_MODE: 'simulation', WHATSAPP_MODE: 'simulation',
    BITPANEL_MODE: 'disabled', AI_ADMIN_ENABLED: 'false', AI_WHATSAPP_ENABLED: 'false',
    TELEGRAM_SYNC_ENABLED: 'false'
  } }), /OUTBOX_STAGING_GUARD_FAILED/);
});
test('shutdown drains active batch before returning and stops new claims', async () => {
  let release, calls = 0;
  const runtime = startOutboxRuntime({ dispatcher: { dispatchBatch() {
    calls++; return new Promise(r => { release = r; });
  } } });
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await stopping; assert.equal(calls, 1);
});
test('polling failure is captured and shutdown remains safe', async () => {
  let errors = 0;
  const runtime = startOutboxRuntime({ dispatcher: { async dispatchBatch() { throw new Error('failure'); } },
    logger: { error() { errors++; } } });
  await runtime.stop(); assert.equal(errors, 1);
});
test('migrator guards reject before connection', async () => {
  await assert.rejects(validateStagingMigrations({}, () => { throw new Error('must not connect'); }), /GUARD/);
});
test('migrator validates existing history, no DDL, closes connection', async () => {
  const migrations = await loadMigrations(); let closed = false; const logs = [];
  await validateStagingMigrations({ GATE_ENVIRONMENT: 'staging-055', GATE_TEST_MODE: 'true',
    GATE_DATABASE_ROLE: 'SOURCE', DATABASE_URL: 'test' }, () => ({
    async query(sql) {
      assert.doesNotMatch(sql, /\b(CREATE|ALTER|INSERT|DELETE|UPDATE)\b/i);
      if (sql.includes('to_regclass')) return { rows: [{ exists: true }] };
      return { rows: migrations };
    }, async close() { closed = true; }
  }), record => logs.push(record));
  assert.equal(closed, true); assert.equal(logs[1].status, 'NO_PENDING_MIGRATIONS');
});
