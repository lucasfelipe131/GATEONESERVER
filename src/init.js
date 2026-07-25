import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { seed } from './seed.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function initializeDatabase(db, config) {
  const schema = await readFile(join(here, 'schema.sql'), 'utf8');
  await db.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gate-one-pro-database-init'))");
    await client.query(schema);
    await seed(client, config);
  });
}
