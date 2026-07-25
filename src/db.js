import pg from 'pg';

const { Pool } = pg;

export function createDb(databaseUrl, { ssl = false } = {}) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000
  });

  return {
    query(text, params) {
      return pool.query(text, params);
    },
    async transaction(callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close() {
      return pool.end();
    },
    pool
  };
}

export async function getSetting(db, key, fallback) {
  const result = await db.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  return result.rows[0]?.value ?? fallback;
}

export async function setSetting(db, key, value, updatedBy = null) {
  await db.query(
    `INSERT INTO system_settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), updatedBy]
  );
}
