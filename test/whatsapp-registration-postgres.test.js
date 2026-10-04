import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrateDatabase } from '../src/migrations.js';
import { registerQrInbound } from '../src/services/customer-memory.js';
import { processWhatsAppRegistration } from '../src/services/whatsapp-registration.js';
import { createCustomerContextSnapshot } from '../src/services/customer-context.js';
import { openSupportCase } from '../src/services/gate-core.js';

function adapter(pg) {
  const client = pg => ({ query: async (sql, params) => {
    const r = !params && /;\s*\S/.test(sql.trim().replace(/;$/, '')) ? (await pg.exec(sql)).at(-1) : await pg.query(sql, params);
    return { ...r, rowCount: r.rowCount ?? r.affectedRows ?? r.rows.length };
  } });
  return { ...client(pg), transaction: fn => pg.transaction(tx => fn(client(tx))) };
}

test('WhatsApp self-registration persists both audiences without granting account or payment access', async t => {
  const pg = new PGlite({ extensions: { pgcrypto } }), db = adapter(pg);
  const fresh = '5511999999001', existing = '5511999999002', unverified = '5511999999003';
  const turn = async (phone, text, messageId = randomUUID(), now) => {
    await registerQrInbound(db, { phone, text, providerId: messageId });
    return processWhatsAppRegistration(db, { phone, text, messageId, ...(now ? { now } : {}) });
  };
  try {
    await migrateDatabase(db);
    const planId = randomUUID();
    await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Mensal',1,3000)", [planId]);
    const existingId = randomUUID(), subscriptionId = randomUUID();
    await db.query(`INSERT INTO customers(id,name,email,whatsapp_e164,bitpanel_reference,status,bitpanel_owner,automation_eligible,consent_contact)
      VALUES($1,'Cliente Atual','atual@example.com',$2,'login-privado','active','Gate Owner',true,true)`, [existingId, existing]);
    await db.query("INSERT INTO subscriptions(id,customer_id,plan_id,status,expires_on) VALUES($1,$2,$3,'active','2026-11-01')", [subscriptionId, existingId, planId]);
    await t.test('new lead completes a draft and confirmation commits once; no billing or activation', async () => {
      assert.equal((await turn(fresh, 'CADASTRO')).registration_step, 'KIND');
      await turn(fresh, '2');
      await turn(fresh, 'Ana de Teste');
      const bad = await turn(fresh, 'email errado'); assert.equal(bad.registration_step, 'EMAIL');
      const result = await turn(fresh, 'ana@example.com', 'email-id'); assert.equal(result.registration_step, 'DEVICE');
      assert.equal((await turn(fresh, 'ana@example.com', 'email-id')).duplicate, true);
      assert.equal((await turn(fresh, 'CONTINUAR CADASTRO')).registration_step, 'DEVICE');
      await turn(fresh, 'TV Samsung'); await turn(fresh, 'Smart One'); await turn(fresh, 'MENSAL');
      await turn(fresh, 'SIM');
      let c = (await db.query('SELECT * FROM customers WHERE whatsapp_e164=$1', [fresh])).rows[0];
      assert.equal(c.email, null, 'draft must not write profile before confirmation');
      const done = await turn(fresh, 'CONFIRMAR', 'final-id'); assert.equal(done.outcome, 'REGISTRATION_COMPLETED');
      assert.equal((await turn(fresh, 'CONFIRMAR', 'final-id')).response_text, done.response_text);
      c = (await db.query('SELECT * FROM customers WHERE whatsapp_e164=$1', [fresh])).rows[0];
      assert.equal(c.name, 'Ana De Teste'); assert.equal(c.email, 'ana@example.com'); assert.equal(c.consent_contact, true);
      assert.equal(c.bitpanel_reference, null); assert.notEqual(c.status, 'active');
      const profile = (await db.query('SELECT value FROM customer_memories WHERE customer_id=$1', [c.id])).rows;
      assert.equal(profile.length, 1); assert.equal(profile[0].value.device, 'TV Samsung'); assert.equal(profile[0].value.requested_plan, 'monthly');
      assert.equal((await db.query('SELECT count(*)::int n FROM subscriptions WHERE customer_id=$1', [c.id])).rows[0].n, 0);
    });
    await t.test('existing customer keeps operational records, email and human hold; explicit opt-out is saved', async () => {
      await db.query("UPDATE customers SET opt_out_at=now() WHERE id=$1", [existingId]);
      await registerQrInbound(db, { phone: existing, text: 'cadastro', providerId: 'prepare-existing' });
      await db.query(`UPDATE conversation_sessions SET state='support',handoff_status='REQUESTED',data='{"legacy":"preserved"}' WHERE whatsapp_e164=$1`, [existing]);
      assert.equal((await turn(existing, 'ATUALIZAR MEUS DADOS')).registration_step, 'NAME');
      await turn(existing, 'MANTER'); await turn(existing, 'PULAR'); await turn(existing, 'TV LG'); await turn(existing, 'PULAR');
      const review = await turn(existing, 'NÃO'); assert.equal(review.registration_step, 'REVIEW');
      await turn(existing, 'CONFIRMAR');
      const c = (await db.query('SELECT * FROM customers WHERE id=$1', [existingId])).rows[0];
      assert.equal(c.email, 'atual@example.com'); assert.equal(c.bitpanel_reference, 'login-privado'); assert.equal(c.bitpanel_owner, 'Gate Owner');
      assert.equal(c.automation_eligible, true); assert.equal(c.consent_contact, false); assert.ok(c.opt_out_at);
      const s = (await db.query('SELECT * FROM conversation_sessions WHERE whatsapp_e164=$1', [existing])).rows[0];
      assert.equal(s.state, 'support'); assert.equal(s.handoff_status, 'REQUESTED'); assert.equal(s.data.legacy, 'preserved');
      assert.equal((await db.query('SELECT expires_on::text AS expires,plan_id FROM subscriptions WHERE id=$1', [subscriptionId])).rows[0].expires, '2026-11-01');
    });
    await t.test('a claimed login on another number creates review without exposing or modifying that account', async () => {
      await turn(unverified, 'CADASTRO'); await turn(unverified, '1');
      const response = await turn(unverified, 'login-privado'); assert.equal(response.registration_step, 'NAME');
      assert.doesNotMatch(response.response_text, /Cliente Atual|atual@example/);
      const candidate = (await db.query('SELECT whatsapp_e164 FROM customers WHERE id=$1', [existingId])).rows[0];
      assert.equal(candidate.whatsapp_e164, existing);
      const link = (await db.query('SELECT * FROM customer_identity_links WHERE whatsapp_e164=$1', [unverified])).rows[0];
      assert.equal(link.status, 'pending'); assert.equal(link.candidate_customer_id, existingId); assert.equal(link.confidence, 0);
      assert.equal((await db.query('SELECT count(*)::int n FROM conversation_handoffs WHERE customer_id=$1', [link.source_customer_id])).rows[0].n, 1);
      await turn(unverified, 'CANCELAR CADASTRO');
      assert.equal((await db.query('SELECT count(*)::int n FROM conversation_handoffs WHERE customer_id=$1', [link.source_customer_id])).rows[0].n, 1);
    });
    await t.test('menu or billing interrupts preserve the draft; cancel discards unsaved data; expired draft is not reused', async () => {
      await turn(fresh, 'CADASTRO'); await turn(fresh, '2'); await turn(fresh, 'Outro Nome');
      assert.equal((await turn(fresh, 'MENU')).handled, false);
      assert.equal((await turn(fresh, 'QUERO RENOVAR')).handled, false);
      assert.equal((await turn(fresh, 'CONTINUAR')).registration_step, 'EMAIL');
      await turn(fresh, 'CANCELAR CADASTRO');
      assert.equal((await db.query('SELECT name FROM customers WHERE whatsapp_e164=$1', [fresh])).rows[0].name, 'Ana De Teste');
      await turn(fresh, 'CADASTRO');
      assert.equal((await turn(fresh, 'CONTINUAR', randomUUID(), new Date(Date.now() + 2 * 86_400_000))).handled, false);
      for (const table of ['charges','payments','renewal_jobs']) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    });
    await t.test('the saved profile is available in the real scoped customer context', async () => {
      const snapshot = await createCustomerContextSnapshot(db, { customerId: existingId, purpose: 'SUPPORT', channel: 'WHATSAPP', requestedScopes: ['MEMORY'], correlationId: randomUUID() });
      const profile = snapshot.customer360.memories.find(m => m.key === 'self_registration.profile');
      assert.equal(profile.value.device, 'TV LG'); assert.equal(profile.customer_id, existingId);
    });
    await t.test('a newly opened technical case matches the partial unique index and emits one event', async () => {
      const input = { customerId: existingId, category: 'TECHNICAL_SUPPORT', summary: 'Suporte sintético',
        message: 'Sem sinal', requestId: randomUUID(), correlationId: randomUUID(), actor: { type: 'SERVICE', id: 'synthetic-test' } };
      const first = await openSupportCase(db, input), duplicate = await openSupportCase(db, input);
      assert.equal(duplicate.id, first.id); assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true);
      assert.equal((await db.query("SELECT count(*)::int n FROM gate_event_outbox WHERE event_type='support.case_opened' AND subject->>'id'=$1", [first.id])).rows[0].n, 1);
    });
  } finally { await pg.close(); }
});
