import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrateDatabase } from '../src/migrations.js';
import { registerQrInbound, setConversationState } from '../src/services/customer-memory.js';
import { normalizePhone } from '../src/security.js';
import { PgConversationAgentRepository, InMemoryConversationAgentRepository,
  HUMAN_HANDOFF_IDLE_TIMEOUT_MS } from '../src/services/conversation-operations.js';

test('human wait resumes at exactly one hour, preserves its ticket, and a new explicit request starts a new wait', async () => {
  let now = Date.parse('2026-10-12T14:00:00Z');
  const repository = new InMemoryConversationAgentRepository({ now: () => now });
  const input = { conversation_id: 'whatsapp:5511999999701', customer_id: 'customer-1',
    idempotency_key: 'initial-request', reason: 'HUMAN_REQUEST' };
  const first = await repository.requestHandoff(input);
  now += HUMAN_HANDOFF_IDLE_TIMEOUT_MS - 1;
  assert.equal((await repository.activeHandoff(input.conversation_id,input.customer_id)).automation_resumed, undefined);
  await repository.requestHandoff({...input,idempotency_key:'duplicate-pending-request'});
  now++;
  const resumed = await repository.activeHandoff(input.conversation_id,input.customer_id);
  assert.equal(resumed.automation_resumed,true);
  assert.equal(resumed.intent.automation_resume_reason,'HUMAN_IDLE_TIMEOUT');
  assert.equal(resumed.status,'REQUESTED');
  assert.equal(resumed.handoff_id,first.handoff_id);
  assert.equal(repository.handoffs.size,1);
  await repository.requestHandoff(input);
  assert.equal((await repository.activeHandoff(input.conversation_id,input.customer_id)).automation_resumed,true);
  await repository.requestHandoff({...input,idempotency_key:'new-explicit-human-request'});
  assert.equal((await repository.activeHandoff(input.conversation_id,input.customer_id)).automation_resumed,false);
  now += HUMAN_HANDOFF_IDLE_TIMEOUT_MS - 1;
  assert.equal((await repository.activeHandoff(input.conversation_id,input.customer_id)).automation_resumed,false);
  now++;
  assert.equal((await repository.activeHandoff(input.conversation_id,input.customer_id)).automation_resumed,true);
  await repository.requestHandoff({...input,idempotency_key:'new-explicit-human-request'});
  assert.equal((await repository.activeHandoff(input.conversation_id,input.customer_id)).automation_resumed,true);
});

test('only fresh human activity postpones the deadline; replay, stale events, other contacts and resolved tickets do not', async () => {
  let now = Date.parse('2026-10-12T14:00:00Z');
  const repository = new InMemoryConversationAgentRepository({ now: () => now });
  const input = { conversation_id:'whatsapp:5511999999702',customer_id:'customer-2',idempotency_key:'human-activity' };
  const handoff = await repository.requestHandoff(input);
  handoff.status = 'ASSIGNED';
  now += 30 * 60_000;
  const activity = { conversationId:input.conversation_id,customerId:input.customer_id,
    messageId:'human-message',occurredAt:new Date(now).toISOString() };
  assert.equal(await repository.recordHumanActivity(activity),true);
  now += 30 * 60_000;
  assert.equal((await repository.activeHandoff(input.conversation_id,input.customer_id)).automation_resumed,false);
  assert.equal(await repository.recordHumanActivity(activity),false);
  assert.equal(await repository.recordHumanActivity({...activity,messageId:'stale',occurredAt:'2026-10-12T14:10:00Z'}),false);
  assert.equal(await repository.recordHumanActivity({...activity,conversationId:'whatsapp:5511999999703'}),false);
  assert.equal(await repository.recordHumanActivity({...activity,customerId:'other-customer'}),false);
  assert.equal(await repository.recordHumanActivity({...activity,messageId:'future',occurredAt:new Date(now+120_000).toISOString()}),false);
  now += 30 * 60_000;
  assert.equal((await repository.activeHandoff(input.conversation_id,input.customer_id)).automation_resumed,true);
  assert.equal(handoff.status,'ASSIGNED');
  handoff.status = 'RESOLVED';
  assert.equal(await repository.recordHumanActivity({...activity,messageId:'late-human',occurredAt:new Date(now).toISOString()}),false);
});

test('PostgreSQL persists the idle deadline, ignores customer traffic and automatic echoes, and keeps the handoff open', async () => {
  const pg = new PGlite({ extensions:{pgcrypto} });
  const wrap = engine => ({ query:async(sql,params) => {
    const result = !params && /;\s*\S/.test(sql.trim().replace(/;$/,''))
      ? (await engine.exec(sql)).at(-1) : await engine.query(sql,params);
    return {...result,rowCount:result.rowCount??result.affectedRows??result.rows.length};
  } });
  const db = {...wrap(pg),transaction:fn=>pg.transaction(tx=>fn(wrap(tx)))};
  try {
    await migrateDatabase(db);
    const phone='5511999999704';
    const initial = await registerQrInbound(db,{phone,text:'ATENDENTE',providerId:randomUUID()});
    const input = { conversation_id:`whatsapp:${phone}`,customer_id:initial.customer.id,
      correlation_id:randomUUID(),idempotency_key:randomUUID(),reason:'HUMAN_REQUEST' };
    const repository = new PgConversationAgentRepository(db);
    const handoff = await repository.requestHandoff(input);
    await db.query("UPDATE conversation_handoffs SET requested_at=now()-interval '61 minutes',updated_at=now() WHERE handoff_id=$1",[handoff.handoff_id]);
    const inbound = await registerQrInbound(db,{phone,text:'oi',providerId:randomUUID()});
    assert.equal(inbound.automationPaused,false);
    const saved = (await db.query('SELECT status,intent FROM conversation_handoffs WHERE handoff_id=$1',[handoff.handoff_id])).rows[0];
    assert.equal(saved.status,'REQUESTED');
    assert.equal(saved.intent.automation_resume_reason,'HUMAN_IDLE_TIMEOUT');
    assert.equal((await new PgConversationAgentRepository(db).activeHandoff(input.conversation_id,input.customer_id)).automation_resumed,true);
    await repository.requestHandoff(input);
    assert.equal((await repository.activeHandoff(input.conversation_id,input.customer_id)).automation_resumed,true);

    await repository.requestHandoff({...input,idempotency_key:randomUUID()});
    await db.query(`UPDATE conversation_handoffs SET requested_at=now()-interval '2 hours',
      intent=jsonb_build_object('human_wait_started_at',now()-interval '50 minutes'),status='ASSIGNED' WHERE handoff_id=$1`,[handoff.handoff_id]);
    const timestamp=(await db.query("SELECT (now()-interval '10 minutes')::text AS value")).rows[0].value;
    const apiConversationId=`whatsapp:${normalizePhone(`+${phone}`).replace(/\D/g,'')}`;
    assert.equal(apiConversationId,input.conversation_id);
    assert.equal(await repository.recordHumanActivity({conversationId:apiConversationId,customerId:input.customer_id,
      messageId:'manual-human-message',occurredAt:timestamp}),true);
    assert.equal((await registerQrInbound(db,{phone,text:'PLANOS',providerId:randomUUID()})).automationPaused,true);
    assert.equal(await repository.recordHumanActivity({conversationId:input.conversation_id,messageId:'manual-human-message',occurredAt:timestamp}),false);
    await db.query(`INSERT INTO message_logs(customer_id,direction,channel,content,provider_id,status)
      VALUES($1,'outbound','whatsapp_qr','Resposta automática sintética','bot-echo','sent')`,[input.customer_id]);
    const current=(await db.query('SELECT now()::text AS value')).rows[0].value;
    assert.equal(await repository.recordHumanActivity({conversationId:input.conversation_id,messageId:'bot-echo',occurredAt:current}),false);
    const before=(await db.query('SELECT intent FROM conversation_handoffs WHERE handoff_id=$1',[handoff.handoff_id])).rows[0].intent;
    await repository.requestHandoff({...input,idempotency_key:randomUUID()});
    const after=(await db.query('SELECT intent FROM conversation_handoffs WHERE handoff_id=$1',[handoff.handoff_id])).rows[0].intent;
    assert.deepEqual(after,before);
    assert.equal((await registerQrInbound(db,{phone,text:'MENU',providerId:randomUUID()})).automationPaused,false);
    assert.equal((await db.query('SELECT status FROM conversation_handoffs WHERE handoff_id=$1',[handoff.handoff_id])).rows[0].status,'ASSIGNED');
    assert.equal(await repository.recordHumanActivity({conversationId:input.conversation_id,messageId:'old-human-after-menu',occurredAt:timestamp}),false);
    assert.equal(await repository.recordHumanActivity({conversationId:'whatsapp:5511999999705',messageId:'wrong-contact',occurredAt:current}),false);
    await db.query("UPDATE conversation_handoffs SET status='RESOLVED' WHERE handoff_id=$1",[handoff.handoff_id]);
    assert.equal(await repository.recordHumanActivity({conversationId:input.conversation_id,messageId:'resolved-contact',occurredAt:current}),false);

    const legacyPhone='5511999999706';
    await registerQrInbound(db,{phone:legacyPhone,text:'ATENDENTE',providerId:randomUUID()});
    await setConversationState(db,legacyPhone,'support');
    await db.query("UPDATE conversation_sessions SET updated_at=now()-interval '2 hours' WHERE whatsapp_e164=$1",[normalizePhone(legacyPhone)]);
    assert.equal((await registerQrInbound(db,{phone:legacyPhone,text:'oi',providerId:randomUUID()})).automationPaused,false);
    const legacy=(await db.query('SELECT status,intent FROM conversation_handoffs WHERE conversation_id=$1',[`whatsapp:${legacyPhone}`])).rows[0];
    assert.equal(legacy.status,'REQUESTED');
    assert.equal(legacy.intent.automation_resume_reason,'HUMAN_IDLE_TIMEOUT');
  } finally { await pg.close(); }
});
