import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createDb } from '../src/db.js';
import { migrateDatabase, migrationStatus, verifyMigrations } from '../src/migrations.js';
import { localSupportEnabled } from '../src/services/support-repository.js';

export function assertStaging06Migration(env) {
  if (env.GATE_ENVIRONMENT !== 'staging-055' || !localSupportEnabled(env) || env.GATE_DATABASE_ROLE !== 'SOURCE' ||
      env.RAILWAY_SERVICE_ID !== '13d818b3-c24e-47c8-a617-4a7ae8ca21f3' ||
      env.OUTBOX_DISPATCHER_ENABLED !== 'false' || env.SEED_DEMO !== 'false')
    throw new Error('STAGING06_MIGRATION_TARGET_GUARD');
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== 'postgres.railway.internal' || (url.port && url.port !== '5432') ||
      !url.username || !url.password || url.pathname.length < 2 || url.search)
    throw new Error('STAGING06_DATABASE_TARGET_GUARD');
  return url;
}

export function assertStaging06History(status) {
  const applied = status.applied.map(m => m.version);
  const previous = ['0000', '0001', '0002', '0003', '0004', '0005'];
  if (applied.join(',') !== previous.join(',') &&
      applied.join(',') !== [...previous, '0006'].join(','))
    throw new Error('STAGING06_UNEXPECTED_HISTORY');
  if (status.pending.length && (status.pending.length !== 1 ||
      status.pending[0].name !== '0006_support_exception_command_center.sql'))
    throw new Error('STAGING06_UNEXPECTED_PENDING_MIGRATION');
}

function run(binary, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('STAGING06_BACKUP_TIMEOUT')); }, 180000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('STAGING06_BACKUP_TOOL_FAILED')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('STAGING06_BACKUP_TOOL_FAILED')); });
  });
}
async function counts(db) {
  const result = await db.query(`SELECT
    (SELECT count(*) FROM customers)::text AS customers,
    (SELECT count(*) FROM subscriptions)::text AS subscriptions,
    (SELECT count(*) FROM charges)::text AS charges,
    (SELECT count(*) FROM payments)::text AS payments`);
  return result.rows[0];
}
export async function migrateStaging06(env = process.env) {
  const url = assertStaging06Migration(env);
  const db = createDb(env.DATABASE_URL, { ssl: env.DATABASE_SSL === 'true' });
  try {
    const before = await migrationStatus(db);
    assertStaging06History(before);
    const initialCounts = await counts(db);
    await mkdir('/backups', { recursive: true });
    const backup = `/backups/gate-staging-pre-phase6-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.dump`;
    const pgEnv = { ...env, PGHOST: url.hostname, PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGSSLMODE: env.DATABASE_SSL === 'true' ? 'require' : 'prefer' };
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', backup], pgEnv);
    const info = await stat(backup);
    if (info.size < 1024) throw new Error('STAGING06_BACKUP_EMPTY');
    await run('pg_restore', ['--list', backup], pgEnv);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(backup)) hash.update(chunk);
    const metadata = { backup, bytes: info.size, sha256: hash.digest('hex'),
      archive_catalog_verified: true, restore_executed: false,
      before: before.applied.map(m => ({ version: m.version, checksum: m.checksum })),
      initial_counts: initialCounts };
    await writeFile(`${backup}.json`, JSON.stringify(metadata, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ event: 'staging06.backup_verified', ...metadata }));
    const migration = await migrateDatabase(db, { executor: 'staging06-controlled-migration' });
    const final = await verifyMigrations(db);
    const finalCounts = await counts(db);
    if (JSON.stringify(initialCounts) !== JSON.stringify(finalCounts))
      throw new Error('STAGING06_BUSINESS_COUNTS_CHANGED');
    const report = { event: 'staging06.migration_verified', applied: migration.executed,
      migrations: final.applied.map(m => ({ version: m.version, checksum: m.checksum })),
      initial_counts: initialCounts, final_counts: finalCounts, backup,
      synthetic_seed_copied: false };
    await writeFile(`${backup}.result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  migrateStaging06().catch(error => {
    // Connection strings and pg tool output are deliberately excluded from deployment logs.
    console.error(['STAGING06_MIGRATION_TARGET_GUARD', 'STAGING06_DATABASE_TARGET_GUARD',
      'STAGING06_UNEXPECTED_HISTORY', 'STAGING06_UNEXPECTED_PENDING_MIGRATION',
      'STAGING06_BACKUP_TIMEOUT', 'STAGING06_BACKUP_TOOL_FAILED', 'STAGING06_BACKUP_EMPTY',
      'STAGING06_BUSINESS_COUNTS_CHANGED'].includes(error.message) ? error.message : 'STAGING06_MIGRATION_FAILED');
    process.exitCode = 1;
  });
