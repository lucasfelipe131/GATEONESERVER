import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { createDb } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });

try {
  const schema = await readFile(join(here, 'schema.sql'), 'utf8');
  await db.query(schema);
  console.log('Migrações aplicadas com sucesso.');
} finally {
  await db.close();
}
