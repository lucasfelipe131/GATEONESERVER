import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { assertQa06, seedQa06, QA06_PROJECT, QA06_ENVIRONMENT } from '../scripts/qa06-bootstrap.js';
import { migrateDatabase, verifyMigrations } from '../src/migrations.js';
import { loadConfig } from '../src/config.js';
import { PgCommandCenter } from '../src/services/command-center.js';
import { PgSupportRepository } from '../src/services/support-repository.js';

const syntheticEnv = {
  RAILWAY_PROJECT_ID: QA06_PROJECT, RAILWAY_ENVIRONMENT_ID: QA06_ENVIRONMENT,
  GATE_QA06: 'true', NODE_ENV: 'test', GATE_ENVIRONMENT: 'test', SUPPORT_AGENT_ENABLED: 'true',
  PROVIDER_MODE: 'fake-only', GLOBAL_PAUSE: 'true', PAYMENT_MODE: 'simulation',
  WHATSAPP_MODE: 'simulation', BITPANEL_MODE: 'disabled', TELEGRAM_SYNC_ENABLED: 'false',
  AI_ADMIN_ENABLED: 'false', AI_WHATSAPP_ENABLED: 'false', SEED_DEMO: 'false',
  DATABASE_URL: 'postgresql://gate_qa06:synthetic@qa06-postgres.railway.internal:5432/gate_qa06',
  ADMIN_EMAIL: 'qa06@gate.example', ADMIN_PASSWORD: 'test-only-synthetic-password-never-used-remotely',
  COOKIE_SECRET: 'test-only-synthetic-cookie-secret-never-used-remotely',
};
test('QA06 startup refuses production projects, external database and live providers before connecting', () => {
  assert.doesNotThrow(() => assertQa06(syntheticEnv));
  for (const override of [
    { RAILWAY_PROJECT_ID: 'a0f107fe-acaf-459f-a640-38ef6010d1e5' },
    { RAILWAY_PROJECT_ID: '4bfa3497-1962-415e-a0b5-30ce86b596fe' },
    { RAILWAY_ENVIRONMENT_ID: 'not-the-qa-environment' }, { NODE_ENV: 'production' },
    { PAYMENT_MODE: 'live' }, { WHATSAPP_MODE: 'live' }, { BITPANEL_MODE: 'live' },
    { DATABASE_URL: 'postgresql://gate_qa06:synthetic@external.invalid:5432/gate_qa06' },
    { REDIS_URL: 'redis://external.invalid' }, { OPENAI_API_KEY: 'synthetic' },
    { GATE_ONE_WHATSAPP_QR_URL: 'https://external.invalid' },
  ]) assert.throws(() => assertQa06({ ...syntheticEnv, ...override }), /QA06_/);
});

function adapter(pg) {
  const client = (p) => ({ query: async (sql, params) => {
    if (!params && /;\s*\S/.test(sql.trim().replace(/;$/, ''))) {
      const results = await p.exec(sql);
      return { ...results.at(-1), rowCount: results.at(-1)?.affectedRows || 0 };
    }
    const r = await p.query(sql, params);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  } });
  return { ...client(pg), transaction: (fn) => pg.transaction((tx) => fn(client(tx))) };
}
test('QA06 migration and synthetic fixtures seed once, with actual persisted support and dashboard read models', async () => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const db = adapter(pg);
  try {
    await migrateDatabase(db);
    const first = await seedQa06(db, loadConfig(syntheticEnv));
    assert.equal(first.seeded, true);
    assert.equal(first.marker.customers, 8);
    assert.ok(first.marker.results.some((r) => r.case_status === 'RESOLVED'));
    assert.ok(first.marker.results.some((r) => r.case_status === 'HUMAN_REQUIRED'));
    assert.ok(first.marker.results.some((r) => r.case_status === 'WAITING_CUSTOMER'));
    const second = await seedQa06(db, loadConfig(syntheticEnv));
    assert.equal(second.seeded, false);
    assert.equal((await verifyMigrations(db)).applied.length, 7);
    const model = new PgCommandCenter({ db, repository: new PgSupportRepository(db) });
    const summary = await model.summary();
    assert.equal(summary.active_customers, 8);
    assert.equal(summary.support_cases, 8);
    assert.equal(summary.active_conversations, 8);
    assert.equal(summary.automatically_resolved, 2);
    assert.ok(summary.human_required >= 2);
    assert.ok((await model.list('exceptions')).items.every((r) => r.customer_name.includes('sintético')));
    await db.query("UPDATE system_settings SET value=jsonb_set(value,'{version}','1') WHERE key='qa06_fixture_v1'");
    await db.query("UPDATE customers SET name_confirmed_at=NULL WHERE source='qa06-synthetic'");
    assert.equal((await seedQa06(db, loadConfig(syntheticEnv))).marker.version, 2);
    assert.ok((await model.list('exceptions')).items.every((r) => r.customer_name.includes('sintético')));
    assert.ok((await model.activity()).items.length > 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM message_logs WHERE simulated')).rows[0].n, 16);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM customers WHERE consent_contact')).rows[0].n, 0);
  } finally { await pg.close(); }
});
