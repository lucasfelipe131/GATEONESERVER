import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrateDatabase } from '../src/migrations.js';
import { verifyHandoffIdle } from '../scripts/handoff-idle-verify.js';

test('one-hour handoff recovery preserves tickets and rolls back all synthetic verification data', async () => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const client = session => ({ query: async (sql, params) => {
    const result = !params && /;\s*\S/.test(sql.trim().replace(/;$/, ''))
      ? (await session.exec(sql)).at(-1) : await session.query(sql, params);
    return { ...result, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
  } });
  const db = { ...client(pg), transaction: fn => pg.transaction(tx => fn(client(tx))) };
  const config = { PAYMENT_MODE: 'simulation', WHATSAPP_MODE: 'simulation', BITPANEL_MODE: 'disabled' };
  const env = { ...config, RAILWAY_PROJECT_ID: 'a0f107fe-acaf-459f-a640-38ef6010d1e5',
    RAILWAY_ENVIRONMENT_ID: '3f3188fb-0289-4f4d-93b9-574cfe1505f5', GATE_TEST_MODE: 'true', PROVIDER_MODE: 'fake-only' };
  try {
    await migrateDatabase(db);
    const report = await verifyHandoffIdle({ db, config, env });
    assert.equal(report.cases.length, 6);
    assert.equal(report.rolledBack, true);
    assert.equal(report.databaseCountsUnchanged, true);
    assert.equal(report.customerMessagesSent, 0);
    await assert.rejects(verifyHandoffIdle({ db: {}, config, env: { ...env,
      RAILWAY_ENVIRONMENT_ID: '697f58fb-5084-4cb3-bd9a-ecdbc921b7bc' } }), assert.AssertionError);
  } finally { await pg.close(); }
});
