import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { registerQrInbound, setConversationState } from '../src/services/customer-memory.js';
import { PgConversationAgentRepository } from '../src/services/conversation-operations.js';
import { GateConversationAgent } from '../src/services/conversation-agent.js';
import { ConversationToolRegistry } from '../src/services/conversation-tools.js';

export async function verifyHandoffSilence({ db, config, env = process.env }) {
  assert.equal(env.RAILWAY_PROJECT_ID, 'a0f107fe-acaf-459f-a640-38ef6010d1e5');
  assert.equal(env.RAILWAY_ENVIRONMENT_ID, '3f3188fb-0289-4f4d-93b9-574cfe1505f5');
  assert.equal(env.GATE_TEST_MODE, 'true');
  assert.equal(env.PROVIDER_MODE, 'fake-only');
  for (const key of ['PAYMENT_MODE', 'WHATSAPP_MODE', 'BITPANEL_MODE']) {
    assert.equal(env[key], key === 'BITPANEL_MODE' ? 'disabled' : 'simulation');
    assert.equal(config[key], env[key]);
  }
  const count = async query => (await query(`SELECT
    (SELECT count(*)::int FROM customers) customers,
    (SELECT count(*)::int FROM conversation_sessions) sessions,
    (SELECT count(*)::int FROM message_logs) messages,
    (SELECT count(*)::int FROM conversation_handoffs) handoffs,
    (SELECT count(*)::int FROM agent_decisions) decisions,
    (SELECT count(*)::int FROM gate_event_outbox) events,
    (SELECT count(*)::int FROM charges) charges,
    (SELECT count(*)::int FROM payments) payments`)).rows[0];
  const before = await count(sql => db.query(sql));
  const rollback = new Error('HANDOFF_VERIFICATION_ROLLBACK');
  const report = { commit: env.RAILWAY_GIT_COMMIT_SHA || null, verifiedAt: new Date().toISOString(),
    providerCalls: 0, messagesSent: 0, realCheckouts: 0, cases: [] };
  try {
    await db.transaction(async client => {
      const isolated = { query: (...args) => client.query(...args), transaction: fn => fn(client) };
      const repository = new PgConversationAgentRepository(isolated);
      const phone = `55119${randomInt(10000000, 99999999)}`;
      assert.equal((await client.query('SELECT id FROM customers WHERE whatsapp_e164=$1', [`+${phone}`])).rowCount, 0);
      const inbound = text => registerQrInbound(isolated, { phone, text, providerId: randomUUID() });
      const start = await inbound('atendente');
      assert.equal(start.automationPaused, false);
      const conversationId = `whatsapp:${phone}`;
      const handoff = await repository.requestHandoff({ conversation_id: conversationId,
        customer_id: start.customer.id, correlation_id: randomUUID(), reason: 'SYNTHETIC_VERIFICATION',
        idempotency_key: randomUUID(), summary: 'Verificação sintética com rollback.' });
      for (const status of ['REQUESTED', 'ASSIGNED']) {
        await client.query('UPDATE conversation_handoffs SET status=$2 WHERE handoff_id=$1', [handoff.handoff_id, status]);
        await client.query("UPDATE conversation_sessions SET expires_at=now()-interval '2 days' WHERE whatsapp_e164=$1", [`+${phone}`]);
        for (const text of ['oi', 'MENU', 'CADASTRO', 'quero pagar', '[Imagem recebida] comprovante']) {
          assert.equal((await inbound(text)).automationPaused, true);
        }
        const agent = new GateConversationAgent({ repository: new PgConversationAgentRepository(isolated),
          registry: new ConversationToolRegistry({ handlers: {
            resolveCustomer: async () => ({ status: 'MATCHED', customer_id: start.customer.id })
          } }) });
        const pending = await agent.process({ conversationId, messageId: randomUUID(), text: 'quero pagar',
          identity: { type: 'WHATSAPP', provider: 'whatsapp', value: phone } });
        assert.equal(pending.outcome, 'HANDOFF_PENDING');
        assert.equal(pending.suppress_reply, true);
        assert.equal(pending.response_text, '');
        report.cases.push({ status, automationPaused: true, reply: 'SUPPRESSED', sessionExpiry: 'DOES_NOT_RESUME' });
      }
      await client.query("UPDATE conversation_handoffs SET status='RESOLVED' WHERE handoff_id=$1", [handoff.handoff_id]);
      assert.equal((await inbound('oi')).automationPaused, false);
      report.cases.push({ status: 'RESOLVED', automationPaused: false });
      const unidentified = await repository.requestHandoff({ conversation_id: conversationId,
        customer_id: null, correlation_id: randomUUID(), reason: 'SYNTHETIC_UNIDENTIFIED',
        idempotency_key: randomUUID() });
      assert.equal((await inbound('MENU')).automationPaused, true);
      report.cases.push({ status: 'UNIDENTIFIED_TO_MATCHED', automationPaused: true });
      await client.query("UPDATE conversation_handoffs SET status='RESOLVED' WHERE handoff_id=$1", [unidentified.handoff_id]);
      const legacyPhone = `55119${randomInt(10000000, 99999999)}`;
      await registerQrInbound(isolated, { phone: legacyPhone, text: 'atendente', providerId: randomUUID() });
      await setConversationState(isolated, legacyPhone, 'support');
      assert.equal((await registerQrInbound(isolated, { phone: legacyPhone, text: 'MENU', providerId: randomUUID() })).automationPaused, true);
      report.cases.push({ status: 'LEGACY_SUPPORT', automationPaused: true });
      const financial = await count(sql => client.query(sql));
      assert.equal(financial.charges, before.charges);
      assert.equal(financial.payments, before.payments);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  assert.deepEqual(await count(sql => db.query(sql)), before);
  return { ...report, rolledBack: true, databaseCountsUnchanged: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig(), db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
  try { console.log('GATE_HANDOFF_SILENCE_VERIFY=' + JSON.stringify(await verifyHandoffSilence({ db, config }))); }
  finally { await db.close(); }
}
