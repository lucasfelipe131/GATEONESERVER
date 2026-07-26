import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { createDb } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });

async function runMigration() {
  try {
    // Carrega e executa schema principal
    const schema = await readFile(join(here, 'schema.sql'), 'utf8');
    await db.query(schema);
    console.log('✅ Schema principal aplicado.');

    // Carrega e executa migrações do chatbot
    try {
      const chatbotSchema = await readFile(join(here, 'migrations', 'add-chatbot-tables.sql'), 'utf8');
      await db.query(chatbotSchema);
      console.log('✅ Tabelas de chatbot aplicadas.');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('⚠️  Arquivo de migração do chatbot não encontrado (opcional).');
      } else {
        throw error;
      }
    }

    console.log('✅ Todas as migrações aplicadas com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao aplicar migrações:', error.message);
    process.exit(1);
  } finally {
    await db.close();
  }
}

runMigration();
