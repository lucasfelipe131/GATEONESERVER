import { pathToFileURL } from 'node:url';
import { createDb } from './db.js';
import { verifyMigrations } from './migrations.js';

export async function validateStagingMigrations(env, connect = createDb, log = console.log) {
  const started = Date.now();
  if (env.GATE_ENVIRONMENT !== 'staging-055' || env.GATE_TEST_MODE !== 'true' ||
      env.GATE_DATABASE_ROLE !== 'SOURCE' || !env.DATABASE_URL) {
    throw new Error('STAGING_SOURCE_GUARD_FAILED');
  }
  log({ status: 'START', environment: 'staging-055', database_role: 'SOURCE' });
  const db = connect(env.DATABASE_URL, { ssl: env.DATABASE_SSL === 'true' });
  try {
    const status = await verifyMigrations(db);
    log({ status: 'NO_PENDING_MIGRATIONS', migrations: status.applied.map(m => m.name),
      pending: status.pending.map(m => m.name), duration_ms: Date.now() - started, exit_code: 0 });
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateStagingMigrations(process.env).catch(() => {
    console.error('GATE_MIGRATOR_VALIDATION_FAILED'); process.exitCode = 1;
  });
}
