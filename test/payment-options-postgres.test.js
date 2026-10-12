import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrateDatabase } from '../src/migrations.js';
import { verifyPaymentConversation } from '../scripts/payment-conversation-verify.js';

test('all four plans, method queries and repeated requests pass the rollback-only PostgreSQL verifier', async () => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const client = pg => ({ query: async (sql, params) => {
    const r = !params && /;\s*\S/.test(sql.trim().replace(/;$/, '')) ? (await pg.exec(sql)).at(-1) : await pg.query(sql, params);
    return { ...r, rowCount: r.rowCount ?? r.affectedRows ?? r.rows.length };
  } });
  const db = { ...client(pg), transaction: fn => pg.transaction(tx => fn(client(tx))) };
  const config = { PAYMENT_MODE: 'simulation', WHATSAPP_MODE: 'simulation', BITPANEL_MODE: 'disabled', PUBLIC_BASE_URL: 'https://staging.example' };
  const env = { ...config, RAILWAY_PROJECT_ID: 'a0f107fe-acaf-459f-a640-38ef6010d1e5',
    RAILWAY_ENVIRONMENT_ID: '3f3188fb-0289-4f4d-93b9-574cfe1505f5', GATE_TEST_MODE: 'true', PROVIDER_MODE: 'fake-only' };
  try {
    await migrateDatabase(db);
    await db.query(`INSERT INTO plans(code,name,duration_months,price_cents,sort_order) VALUES
      ('monthly','Mensal',1,3000,1),('quarterly','Trimestral',3,8500,2),
      ('semiannual','Semestral',6,15000,3),('annual','Anual',12,27000,4)`);
    const report = await verifyPaymentConversation({ db, config, env });
    assert.equal(report.cases.length, 4); assert.equal(report.rolledBack, true);
    assert.equal(report.databaseCountsUnchanged, true); assert.equal(report.realCheckouts, 0);
    assert.equal(report.messagesSent, 0);
    for (const patch of [{ RAILWAY_ENVIRONMENT_ID: '697f58fb-5084-4cb3-bd9a-ecdbc921b7bc' },
      { PAYMENT_MODE: 'live' }, { PROVIDER_MODE: 'live' }, { GATE_TEST_MODE: 'false' }]) {
      await assert.rejects(verifyPaymentConversation({ db: { query: () => { throw new Error('must not connect'); } }, config, env: { ...env, ...patch } }), assert.AssertionError);
    }
  } finally { await pg.close(); }
});
