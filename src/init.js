import { verifyMigrations } from './migrations.js';

export async function verifyDatabaseReady(db) {
  return verifyMigrations(db);
}
