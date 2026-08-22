import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIRECTORY = join(here, '..', 'database', 'migrations');

export const BASELINE_TABLES = Object.freeze([
  'users',
  'sessions',
  'plans',
  'customers',
  'customer_identity_links',
  'subscriptions',
  'charges',
  'message_logs',
  'renewal_jobs',
  'leads',
  'conversation_sessions',
  'customer_issues',
  'content_updates',
  'loyalty_ledger',
  'webhook_events',
  'audit_logs',
  'system_settings',
  'integration_credentials',
  'ai_messages'
]);

export function migrationChecksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

export async function loadMigrations(directory = DEFAULT_MIGRATIONS_DIRECTORY) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const migrations = [];
  for (const entry of entries) {
    const sql = await readFile(join(directory, entry.name), 'utf8');
    migrations.push({
      version: entry.name.slice(0, 4),
      name: entry.name,
      sql,
      checksum: migrationChecksum(sql)
    });
  }
  const versions = migrations.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length) {
    throw new Error('Existem migrations com a mesma versão.');
  }
  if (!migrations.length || migrations[0].version !== '0000') {
    throw new Error('A migration 0000_baseline.sql é obrigatória.');
  }
  return migrations;
}

async function migrationTableExists(db) {
  const result = await db.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
  return result.rows[0]?.exists === true;
}

async function appliedMigrations(db) {
  const result = await db.query(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version'
  );
  return result.rows;
}

function validateApplied(migrations, applied) {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = byVersion.get(row.version);
    if (!migration) throw new Error(`Migration aplicada ${row.version} não existe no código.`);
    if (migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(`Checksum divergente para a migration ${row.version}.`);
    }
  }
  const appliedVersions = new Set(applied.map((row) => row.version));
  return migrations.filter((migration) => !appliedVersions.has(migration.version));
}

export async function migrationStatus(db, { directory = DEFAULT_MIGRATIONS_DIRECTORY } = {}) {
  const migrations = await loadMigrations(directory);
  if (!(await migrationTableExists(db))) {
    return { ready: false, applied: [], pending: migrations };
  }
  const applied = await appliedMigrations(db);
  const pending = validateApplied(migrations, applied);
  return { ready: pending.length === 0, applied, pending };
}

export async function verifyMigrations(db, options = {}) {
  const status = await migrationStatus(db, options);
  if (!status.ready) {
    const error = new Error(
      status.applied.length
        ? `Banco possui migrations pendentes: ${status.pending.map((item) => item.name).join(', ')}.`
        : 'Banco ainda não adotou o lifecycle de migrations. Execute o comando controlado de migration.'
    );
    error.code = 'DATABASE_MIGRATIONS_REQUIRED';
    throw error;
  }
  return status;
}

async function listBusinessTables(client) {
  const result = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migrations'
      ORDER BY table_name`
  );
  return result.rows.map((row) => row.table_name);
}

function assertBaselineCompatible(existingTables) {
  const existing = new Set(existingTables);
  const missing = BASELINE_TABLES.filter((table) => !existing.has(table));
  if (missing.length) {
    throw new Error(`Baseline recusado; tabelas obrigatórias ausentes: ${missing.join(', ')}.`);
  }
}

export async function migrateDatabase(db, {
  baselineExisting = false,
  directory = DEFAULT_MIGRATIONS_DIRECTORY,
  executor = 'controlled-cli'
} = {}) {
  const migrations = await loadMigrations(directory);
  return db.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gate-os-schema-migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         name text NOT NULL UNIQUE,
         checksum text NOT NULL,
         executor text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    let applied = await appliedMigrations(client);
    const existingTables = await listBusinessTables(client);

    if (baselineExisting && !applied.length) {
      assertBaselineCompatible(existingTables);
      const baseline = migrations[0];
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum, executor)
         VALUES ($1, $2, $3, $4)`,
        [baseline.version, baseline.name, baseline.checksum, executor]
      );
      applied = await appliedMigrations(client);
    } else if (!baselineExisting && !applied.length && existingTables.length) {
      throw new Error(
        'Banco existente sem baseline. Verifique o schema e execute migrate com --baseline.'
      );
    }

    const pending = validateApplied(migrations, applied);
    const executed = [];
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum, executor)
         VALUES ($1, $2, $3, $4)`,
        [migration.version, migration.name, migration.checksum, executor]
      );
      executed.push(migration.name);
    }
    return { executed, baselineAdopted: baselineExisting && applied.length === 1 };
  });
}
