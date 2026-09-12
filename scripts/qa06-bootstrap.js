import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { migrateDatabase, verifyMigrations } from '../src/migrations.js';
import { seed } from '../src/seed.js';
import { PgSupportRepository } from '../src/services/support-repository.js';
import { createCustomerContextSnapshot } from '../src/services/customer-context.js';
import { fixture } from './support-fixture.js';

// Deployment/fixture setup only. No production module imports this entry point.
export const QA06_PROJECT = 'ff402bb5-9086-4c6a-af39-4de3fb9ca242';
export const QA06_ENVIRONMENT = '0fc4f61f-bbd1-41e4-b0af-25c8013ffae3';
export function assertQa06(env) {
  const required = {
    RAILWAY_PROJECT_ID: QA06_PROJECT,
    RAILWAY_ENVIRONMENT_ID: QA06_ENVIRONMENT,
    GATE_QA06: 'true', NODE_ENV: 'test', GATE_ENVIRONMENT: 'test',
    SUPPORT_AGENT_ENABLED: 'true', PROVIDER_MODE: 'fake-only',
    GLOBAL_PAUSE: 'true', PAYMENT_MODE: 'simulation',
    WHATSAPP_MODE: 'simulation', BITPANEL_MODE: 'disabled',
    TELEGRAM_SYNC_ENABLED: 'false', AI_ADMIN_ENABLED: 'false',
    AI_WHATSAPP_ENABLED: 'false', SEED_DEMO: 'false',
  };
  for (const [key, expected] of Object.entries(required))
    if (env[key] !== expected) throw new Error(`QA06_GUARD_${key}`);
  for (const key of ['REDIS_URL', 'OPENAI_API_KEY', 'MERCADOPAGO_ACCESS_TOKEN',
    'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'BITPANEL_USERNAME',
    'BITPANEL_PASSWORD', 'GATE_ONE_WHATSAPP_QR_URL', 'GATE_ONE_BOT_SECRET'])
    if (env[key]) throw new Error(`QA06_FORBIDDEN_${key}`);
  const db = new URL(env.DATABASE_URL);
  if (db.protocol !== 'postgresql:' || db.hostname !== 'qa06-postgres.railway.internal' ||
      db.pathname !== '/gate_qa06' || db.username !== 'gate_qa06' || db.port !== '5432' || db.search)
    throw new Error('QA06_DATABASE_TARGET');
  if (env.ADMIN_EMAIL !== 'qa06@gate.example' || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 24)
    throw new Error('QA06_SYNTHETIC_ADMIN');
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 48) throw new Error('QA06_COOKIE_SECRET');
}

export async function seedQa06(db, config) {
  return db.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(600006)');
    const marker = await client.query("SELECT value FROM system_settings WHERE key='qa06_fixture_v1'");
    if (marker.rows.length) {
      const previous = marker.rows[0].value;
      if (previous.version === 1) {
        const ids = previous.results.map((r) => r.customer_id);
        const synthetic = await client.query("SELECT id FROM customers WHERE id=ANY($1::uuid[]) AND source='qa06-synthetic'", [ids]);
        if (synthetic.rows.length !== 8) throw new Error('QA06_FIXTURE_IDENTITY_GUARD');
        await client.query("UPDATE customers SET name_confirmed_at=COALESCE(name_confirmed_at,now()) WHERE id=ANY($1::uuid[]) AND source='qa06-synthetic'", [ids]);
        // Complete synthetic fixture metadata through the existing authoritative projection.
        const scoped = { query: (sql, params) => client.query(sql, params), transaction: (fn) => fn(scoped) };
        for (const id of ids) {
          const { customer360 } = await createCustomerContextSnapshot(scoped, { customerId: id, purpose: 'CONVERSATION', channel: 'ADMIN', correlationId: randomUUID() });
          await client.query("UPDATE customer_issues SET support_data=jsonb_set(support_data,'{context,identity}',$2::jsonb) WHERE customer_id=$1 AND support_data IS NOT NULL", [id, JSON.stringify(customer360.identity)]);
          await client.query("UPDATE support_exceptions SET data=jsonb_set(data,'{context,identity}',$2::jsonb) WHERE customer_id=$1", [id, JSON.stringify(customer360.identity)]);
        }
        previous.version = 2;
        await client.query("UPDATE system_settings SET value=$1::jsonb WHERE key='qa06_fixture_v1'", [JSON.stringify(previous)]);
      }
      return { seeded: false, marker: previous };
    }
    const existing = await client.query('SELECT count(*)::int AS n FROM customers');
    if (existing.rows[0].n !== 0) throw new Error('QA06_REQUIRES_EMPTY_CUSTOMER_DATABASE');
    // All fixture writes commit atomically, including support effects and outbox.
    const scoped = { query: (sql, params) => client.query(sql, params), transaction: (fn) => fn(scoped) };
    await seed(scoped, config);
    const plan = randomUUID();
    await client.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'qa06-synthetic','Plano sintético QA 06',1,3000)", [plan]);
    const names = ['Ana Martins', 'João de Oliveira da Silva — nome extenso para validação visual',
      'Marina Costa', 'Rafael Souza', 'Beatriz Lima', 'Carlos Almeida', 'Luiza Nunes', 'Pedro Santos'];
    const results = [];
    for (let group = 0; group < 4; group++) {
      const customers = [randomUUID(), randomUUID()];
      for (let index = 0; index < 2; index++) {
        const id = customers[index];
        await client.query("INSERT INTO customers(id,name,whatsapp_e164,source,status,consent_contact,name_confirmed_at) VALUES($1,$2,$3,'qa06-synthetic','active',false,now())",
          [id, `${names[group * 2 + index]} · sintético`, `fake-qa06-${group}-${index}`]);
        const subscription = randomUUID();
        await client.query("INSERT INTO subscriptions(id,customer_id,plan_id,status,starts_on,expires_on,provider) VALUES($1,$2,$3,'active','2026-01-01','2030-01-01','fake')", [subscription, id, plan]);
        await client.query("INSERT INTO payments(customer_id,subscription_id,provider,amount_cents,status,idempotency_key,correlation_id,confirmed_at) VALUES($1,$2,'fake',3000,$3,$4,$5,CASE WHEN $3='CONFIRMED' THEN now() ELSE NULL END)",
          [id, subscription, group === 0 ? 'CONFIRMED' : 'PENDING', `qa06-payment-${id}`, randomUUID()]);
        await client.query("INSERT INTO customer_memories(customer_id,memory_type,memory_key,value,source,confidence,observed_at) VALUES($1,'PREFERENCE','qa06-contact',$2::jsonb,'QA06_FIXTURE','HIGH',now())",
          [id, JSON.stringify({ text: 'Prefere orientações curtas e objetivas. Informação exclusivamente sintética.' })]);
      }
      const repository = new PgSupportRepository(scoped);
      const f = await fixture({ repository, customers, known: group !== 1, fail: group === 3,
        unverifiable: group === 2, contextLoader: async (customerId) =>
          (await createCustomerContextSnapshot(scoped, { customerId, purpose: 'CONVERSATION',
            channel: 'ADMIN', correlationId: randomUUID() })).customer360 });
      for (let index = 0; index < 2; index++) {
        const id = customers[index], conversationId = f.conversationIds.get(id);
        const text = group === 1 ? 'Não está funcionando e preciso de ajuda para identificar o problema no dispositivo sintético.' : 'não está funcionando';
        await client.query("INSERT INTO conversation_sessions(whatsapp_e164,conversation_id,customer_id,channel,state,context_state,started_at,last_activity_at,summary,handoff_status,expires_at) VALUES($1,$2,$3,'WHATSAPP','support','SUPPORT',now(),now(),$4,'NONE',now()+interval '30 days')",
          [`fake-qa06-${group}-${index}`, conversationId, id, text]);
        const result = await f.run(text, id);
        for (const [direction, content] of [['inbound', text], ['outbound', result.response_text]])
          await client.query("INSERT INTO message_logs(customer_id,conversation_id,direction,content_type,content,channel,status,simulated,processing_status,correlation_id) VALUES($1,$2,$3,'TEXT',$4,'whatsapp','simulated',true,'COMPLETED',$5)",
            [id, conversationId, direction, content || 'Resposta sintética registrada no Core.', randomUUID()]);
        const cases = await repository.list('cases', { customer_id: id });
        results.push({ customer_id: id, case_status: cases[0]?.status, outcome: result.outcome });
      }
    }
    const markerValue = { version: 2, synthetic: true, customers: 8, results };
    await client.query("INSERT INTO system_settings(key,value) VALUES('qa06_fixture_v1',$1::jsonb)", [JSON.stringify(markerValue)]);
    return { seeded: true, marker: markerValue };
  });
}

export async function bootstrapQa06(env = process.env) {
  assertQa06(env);
  const db = createDb(env.DATABASE_URL);
  try {
    const migration = await migrateDatabase(db);
    const history = await verifyMigrations(db);
    const data = await seedQa06(db, loadConfig(env));
    console.log(JSON.stringify({ event: 'qa06.bootstrap', project_id: QA06_PROJECT,
      environment_id: QA06_ENVIRONMENT, applied: migration.executed,
      migrations: history.applied.map((m) => ({ version: m.version, checksum: m.checksum })),
      seeded: data.seeded, synthetic_customers: data.marker.customers }));
  } finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  bootstrapQa06().catch((error) => { console.error(error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[REDACTED]')); process.exitCode = 1; });
