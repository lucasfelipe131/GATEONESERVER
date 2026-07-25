import bcrypt from 'bcryptjs';
import { loadConfig } from './config.js';
import { createDb } from './db.js';

export async function seed(db, config) {
  await db.query(
    `INSERT INTO plans (code, name, duration_months, price_cents, description, sort_order)
     VALUES ('monthly', 'Mensal', 1, 3000, 'Todos os canais de esportes, filmes on-demand e séries on-demand das principais plataformas.', 1),
            ('quarterly', 'Trimestral', 3, 8500, 'Todos os canais de esportes, filmes on-demand e séries on-demand das principais plataformas, com economia no ciclo.', 2),
            ('semiannual', 'Semestral', 6, 15000, 'Todos os canais de esportes, filmes on-demand e séries on-demand das principais plataformas, com seis meses de tranquilidade.', 3),
            ('annual', 'Anual', 12, 27000, 'Todos os canais de esportes, filmes on-demand e séries on-demand das principais plataformas, pelo melhor valor anual.', 4)
     ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name,
           duration_months = EXCLUDED.duration_months,
           price_cents = EXCLUDED.price_cents,
           description = EXCLUDED.description,
           active = true,
           sort_order = EXCLUDED.sort_order`
  );

  const defaults = {
    global_pause: config.GLOBAL_PAUSE,
    sales_mode: config.SALES_MODE,
    payment_mode: config.PAYMENT_MODE,
    whatsapp_mode: config.WHATSAPP_MODE,
    bitpanel_mode: config.BITPANEL_MODE,
    renewal_requires_approval: config.RENEWAL_REQUIRES_APPROVAL
  };
  for (const [key, value] of Object.entries(defaults)) {
    await db.query(
      `INSERT INTO system_settings (key, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }

  if (config.ADMIN_EMAIL && config.ADMIN_PASSWORD) {
    const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 12);
    await db.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, lower($2), $3, 'admin')
       ON CONFLICT ((lower(email))) DO UPDATE
         SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, active = true`,
      [config.ADMIN_NAME, config.ADMIN_EMAIL, passwordHash]
    );
  }

  if (config.SEED_DEMO) {
    const customer = await db.query(
      `INSERT INTO customers (name, whatsapp_e164, source, status, consent_contact)
       VALUES ('Cliente demonstração', '5555999999999', 'demo', 'active', true)
       ON CONFLICT (whatsapp_e164) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const plan = await db.query("SELECT id FROM plans WHERE code = 'monthly'");
    await db.query(
      `INSERT INTO subscriptions (customer_id, plan_id, starts_on, expires_on, status, bitpanel_list_id)
       SELECT $1, $2, CURRENT_DATE - 27, CURRENT_DATE + 3, 'active', 'DEMO-001'
       WHERE NOT EXISTS (
         SELECT 1 FROM subscriptions WHERE customer_id = $1 AND status = 'active'
       )`,
      [customer.rows[0].id, plan.rows[0].id]
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
  try {
    await seed(db, config);
    console.log('Dados iniciais configurados.');
  } finally {
    await db.close();
  }
}
