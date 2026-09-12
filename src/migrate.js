import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrateDatabase, migrationStatus, verifyMigrations } from './migrations.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
const command = process.argv[2] || '--apply';

try {
  if (command === '--status') {
    const status = await migrationStatus(db);
    console.log({
      ready: status.ready,
      applied: status.applied.map((item) => item.name),
      pending: status.pending.map((item) => item.name)
    });
  } else if (command === '--verify') {
    const status = await verifyMigrations(db);
    console.log({ ready: status.ready, applied: status.applied.map((item) => item.name) });
  } else if (command === '--baseline') {
    const result = await migrateDatabase(db, { baselineExisting: true });
    console.log({ ok: true, ...result });
  } else if (command === '--apply') {
    const result = await migrateDatabase(db);
    console.log({ ok: true, ...result });
  } else {
    throw new Error('Comando inválido. Use --apply, --baseline, --status ou --verify.');
  }
} finally {
  await db.close();
}
