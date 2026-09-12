import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  BASELINE_TABLES,
  loadMigrations,
  migrateDatabase,
  migrationChecksum,
  migrationStatus,
  verifyMigrations
} from '../src/migrations.js';

function createMigrationDb({ tables = [], applied = [], migrationTable = false } = {}) {
  const state = {
    tables: new Set(tables),
    applied: applied.map((item) => ({ ...item })),
    migrationTable,
    statements: []
  };

  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      state.statements.push(normalized);
      if (normalized.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ exists: state.migrationTable }] };
      }
      if (normalized.startsWith('SELECT version, name, checksum, applied_at FROM schema_migrations')) {
        return { rows: state.applied.map((item) => ({ ...item })) };
      }
      if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
        state.migrationTable = true;
        return { rows: [] };
      }
      if (normalized.includes('FROM information_schema.tables')) {
        return { rows: [...state.tables].sort().map((table_name) => ({ table_name })) };
      }
      if (normalized.startsWith('INSERT INTO schema_migrations')) {
        state.applied.push({
          version: params[0],
          name: params[1],
          checksum: params[2],
          executor: params[3],
          applied_at: '2026-08-22T00:00:00.000Z'
        });
        return { rows: [] };
      }
      if (normalized.includes('CREATE TABLE IF NOT EXISTS users')) {
        for (const table of BASELINE_TABLES) state.tables.add(table);
      }
      return { rows: [] };
    }
  };

  return {
    state,
    query: client.query,
    async transaction(callback) {
      const snapshot = {
        tables: new Set(state.tables),
        applied: state.applied.map((item) => ({ ...item })),
        migrationTable: state.migrationTable
      };
      try {
        return await callback(client);
      } catch (error) {
        state.tables = snapshot.tables;
        state.applied = snapshot.applied;
        state.migrationTable = snapshot.migrationTable;
        throw error;
      }
    }
  };
}

test('carrega baseline e migrations em ordem com checksum estável', async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(migrations.map((item) => item.version), ['0000', '0001', '0002']);
  assert.equal(migrations[0].name, '0000_baseline.sql');
  assert.equal(migrations[1].name, '0001_session_step_up.sql');
  assert.equal(migrations[2].name, '0002_gate_core_contracts.sql');
  assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/);
  assert.equal(migrationChecksum(migrations[0].sql), migrations[0].checksum);
});

test('baseline contém todas as tabelas empresariais esperadas', async () => {
  const baseline = await readFile(
    new URL('../database/migrations/0000_baseline.sql', import.meta.url),
    'utf8'
  );
  for (const table of BASELINE_TABLES) {
    assert.match(baseline, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
  }
});

test('step-up é uma migration aditiva', async () => {
  const migration = await readFile(
    new URL('../database/migrations/0001_session_step_up.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS step_up_until timestamptz/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS step_up_capability text/);
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|TRUNCATE)\b/i);
});

test('GATE Core usa migration EXPAND sem remoção destrutiva', async () => {
  const migration = await readFile(
    new URL('../database/migrations/0002_gate_core_contracts.sql', import.meta.url),
    'utf8'
  );
  for (const table of [
    'customer_identities',
    'payments',
    'provisioning_operations',
    'gate_event_outbox',
    'gate_event_consumptions'
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
  }
  assert.match(migration, /ALTER TABLE renewal_jobs[\s\S]*ADD COLUMN IF NOT EXISTS core_status text/);
  assert.doesNotMatch(
    migration,
    /\b(?:DROP\s+(?:TABLE|COLUMN)|DELETE\s+FROM|TRUNCATE|RENAME\s+(?:TABLE|COLUMN))\b/i
  );
});

test('web e worker apenas verificam migrations no startup', async () => {
  const [server, worker, init] = await Promise.all([
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/worker.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/init.js', import.meta.url), 'utf8')
  ]);
  assert.match(server, /await verifyDatabaseReady\(db\)/);
  assert.match(worker, /await verifyDatabaseReady\(db\)/);
  assert.doesNotMatch(server, /initializeDatabase/);
  assert.doesNotMatch(worker, /initializeDatabase/);
  assert.doesNotMatch(init, /seed\(|schema\.sql|CREATE TABLE|ALTER TABLE/);
});

test('migration do zero aplica baseline e mudanças uma única vez', async () => {
  const db = createMigrationDb();
  const first = await migrateDatabase(db);
  const second = await migrateDatabase(db);

  assert.deepEqual(first.executed, [
    '0000_baseline.sql',
    '0001_session_step_up.sql',
    '0002_gate_core_contracts.sql'
  ]);
  assert.deepEqual(second.executed, []);
  assert.deepEqual(db.state.applied.map((item) => item.version), ['0000', '0001', '0002']);
  assert.equal((await migrationStatus(db)).ready, true);
  assert.equal((await verifyMigrations(db)).ready, true);
});

test('banco existente exige adoção explícita do baseline', async () => {
  const db = createMigrationDb({ tables: BASELINE_TABLES });
  await assert.rejects(
    migrateDatabase(db),
    /Banco existente sem baseline/
  );
  assert.equal(db.state.migrationTable, false);
  assert.deepEqual(db.state.applied, []);
});

test('adoção compatível registra baseline sem reexecutá-lo e aplica apenas pendências', async () => {
  const db = createMigrationDb({ tables: BASELINE_TABLES });
  const result = await migrateDatabase(db, { baselineExisting: true });

  assert.equal(result.baselineAdopted, true);
  assert.deepEqual(result.executed, ['0001_session_step_up.sql', '0002_gate_core_contracts.sql']);
  assert.deepEqual(db.state.applied.map((item) => item.version), ['0000', '0001', '0002']);
});

test('adoção recusa baseline incompleto e checksum divergente', async () => {
  const incomplete = createMigrationDb({ tables: BASELINE_TABLES.slice(1) });
  await assert.rejects(
    migrateDatabase(incomplete, { baselineExisting: true }),
    /tabelas obrigatórias ausentes: users/
  );

  const migrations = await loadMigrations();
  const drifted = createMigrationDb({
    tables: BASELINE_TABLES,
    migrationTable: true,
    applied: [{
      version: '0000',
      name: migrations[0].name,
      checksum: '0'.repeat(64),
      applied_at: '2026-08-22T00:00:00.000Z'
    }]
  });
  await assert.rejects(migrationStatus(drifted), /Checksum divergente/);
});
