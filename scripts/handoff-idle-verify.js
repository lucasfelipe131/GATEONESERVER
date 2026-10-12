import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { registerQrInbound, logQrOutbound, setConversationState } from '../src/services/customer-memory.js';
import { PgConversationAgentRepository } from '../src/services/conversation-operations.js';
import { normalizePhone } from '../src/security.js';

async function assertSyntheticPhoneAvailable(client, phone) {
  const normalized = normalizePhone(phone).replace(/\D/g, '');
  const variants = [normalized];
  if (normalized.length === 13 && normalized[4] === '9') variants.push(normalized.slice(0,4) + normalized.slice(5));
  const found = await client.query(`SELECT id FROM customers
    WHERE regexp_replace(COALESCE(whatsapp_e164,''),'[^0-9]','','g')=ANY($1::text[])`, [variants]);
  assert.equal(found.rowCount,0,'O telefone sintético já pertence a um cadastro existente.');
}

export async function verifyHandoffIdle({ db, config, env = process.env,
  phoneFactory = () => `55119${randomInt(10000000, 99999999)}` }) {
  assert.equal(env.RAILWAY_PROJECT_ID, 'a0f107fe-acaf-459f-a640-38ef6010d1e5');
  assert.equal(env.RAILWAY_ENVIRONMENT_ID, '3f3188fb-0289-4f4d-93b9-574cfe1505f5');
  assert.equal(env.GATE_TEST_MODE, 'true');
  assert.equal(env.PROVIDER_MODE, 'fake-only');
  for (const key of ['PAYMENT_MODE', 'WHATSAPP_MODE', 'BITPANEL_MODE']) {
    assert.equal(env[key], key === 'BITPANEL_MODE' ? 'disabled' : 'simulation');
    assert.equal(config[key], env[key]);
  }
  const counts = async query => (await query(`SELECT
    (SELECT count(*)::int FROM customers) customers,
    (SELECT count(*)::int FROM conversation_sessions) sessions,
    (SELECT count(*)::int FROM message_logs) messages,
    (SELECT count(*)::int FROM conversation_handoffs) handoffs,
    (SELECT count(*)::int FROM agent_decisions) decisions,
    (SELECT count(*)::int FROM gate_event_outbox) events,
    (SELECT count(*)::int FROM charges) charges,
    (SELECT count(*)::int FROM payments) payments`)).rows[0];
  const before = await counts(sql => db.query(sql));
  const rollback = new Error('HANDOFF_IDLE_VERIFICATION_ROLLBACK');
  const report = { commit: env.RAILWAY_GIT_COMMIT_SHA || null,
    verifiedAt: new Date().toISOString(), idleTimeoutMinutes: 60,
    providerCalls: 0, customerMessagesSent: 0, realCheckouts: 0, cases: [] };
  try {
    await db.transaction(async client => {
      const isolated = { query: (...args) => client.query(...args), transaction: fn => fn(client) };
      const repository = new PgConversationAgentRepository(isolated);
      const phone = phoneFactory();
      await assertSyntheticPhoneAvailable(client,phone);
      const inbound = text => registerQrInbound(isolated, { phone, text, providerId: randomUUID() });
      const start = await inbound('atendente');
      const conversationId = `whatsapp:${phone}`;
      const handoff = await repository.requestHandoff({ conversation_id: conversationId,
        customer_id: start.customer.id, correlation_id: randomUUID(), reason: 'SYNTHETIC_IDLE_VERIFICATION',
        idempotency_key: randomUUID() });
      const activity = (messageId, occurredAt) => repository.recordHumanActivity({
        conversationId, customerId: start.customer.id, messageId, occurredAt });
      const serverNow = new Date((await client.query('SELECT now() AS at')).rows[0].at).getTime();
      const at = minutesAgo => new Date(serverNow - minutesAgo * 60_000).toISOString();
      assert.equal((await inbound('oi')).automationPaused, true);
      report.cases.push({ name: 'freshHumanWait', automaticPaused: true });

      await client.query("UPDATE conversation_handoffs SET requested_at=now()-interval '61 minutes',intent='{}'::jsonb WHERE handoff_id=$1", [handoff.handoff_id]);
      assert.equal((await inbound('oi')).automationPaused, false);
      const expired = await repository.activeHandoff(conversationId, start.customer.id);
      assert.equal(expired.intent.automation_resume_reason, 'HUMAN_IDLE_TIMEOUT');
      assert.equal(expired.status, 'REQUESTED');
      report.cases.push({ name: 'oneHourWithoutHuman', automaticResumed: true, customerMessageDoesNotExtendWait: true, ticketPreserved: true });

      await repository.requestHandoff({ conversation_id: conversationId, customer_id: start.customer.id });
      await client.query("UPDATE conversation_handoffs SET requested_at=now()-interval '90 minutes',intent='{}'::jsonb WHERE handoff_id=$1", [handoff.handoff_id]);
      assert.equal(await activity('synthetic-human-1', at(30)), true);
      assert.equal((await inbound('PLANOS')).automationPaused, true);
      assert.equal(await activity('synthetic-human-1', at(20)), false);
      assert.equal(await activity('synthetic-human-older', at(40)), false);
      report.cases.push({ name: 'humanReplyRenewsWait', automaticPaused: true, duplicateAndOlderActivityIgnored: true });

      const automaticId = randomUUID();
      await logQrOutbound(isolated, { phone, text: 'Resposta automática sintética não enviada.', providerId: automaticId });
      assert.equal(await activity(automaticId, at(0)), false);
      report.cases.push({ name: 'automaticEcho', doesNotExtendHumanWait: true });

      await client.query("UPDATE conversation_handoffs SET status='ASSIGNED',requested_at=now()-interval '2 hours',intent=jsonb_build_object('last_human_activity_at',now()-interval '61 minutes') WHERE handoff_id=$1", [handoff.handoff_id]);
      assert.equal((await inbound('oi')).automationPaused, false);
      assert.equal((await repository.activeHandoff(conversationId, start.customer.id)).status, 'ASSIGNED');
      report.cases.push({ name: 'oneHourAfterLastHumanReply', automaticResumed: true, assignedTicketPreserved: true });

      const mediaPhone = phoneFactory();
      await assertSyntheticPhoneAvailable(client,mediaPhone);
      const mediaCustomer = await registerQrInbound(isolated, { phone: mediaPhone, text: '[PDF recebido: teste.pdf]', providerId: randomUUID() });
      await setConversationState(isolated, mediaPhone, 'support_media');
      assert.equal((await registerQrInbound(isolated, { phone: mediaPhone, text: 'oi', providerId: randomUUID() })).automationPaused, false);
      assert.equal(await repository.activeHandoff(`whatsapp:${mediaPhone}`, mediaCustomer.customer.id), null);
      report.cases.push({ name: 'attachmentReview', doesNotCreateHumanPause: true });
      const during = await counts(sql => client.query(sql));
      assert.equal(during.charges, before.charges);
      assert.equal(during.payments, before.payments);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  assert.deepEqual(await counts(sql => db.query(sql)), before);
  return { ...report, rolledBack: true, databaseCountsUnchanged: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig(), db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
  try { console.log('GATE_HANDOFF_IDLE_VERIFY=' + JSON.stringify(await verifyHandoffIdle({ db, config }))); }
  finally { await db.close(); }
}
