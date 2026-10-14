import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrateDatabase } from '../src/migrations.js';
import { encryptSecret, decryptSecret } from '../src/security.js';
import { runWhatsAppIdentityScan } from '../src/services/whatsapp-identity-scan.js';
import { assertWhatsAppIdentityScanEnvironment, parseWhatsAppIdentityScanArgs } from '../scripts/whatsapp-identity-scan.js';

const config = { COOKIE_SECRET: 'synthetic-whatsapp-identity-encryption-secret', BITPANEL_BASE_URL: 'https://bitpanel.vip',
  BITPANEL_STORAGE_STATE: 'synthetic-encrypted-session' };
const clock = new Date('2026-10-13T01:00:00.000Z');
const phone = '5511999999701';
const username = 'synthetic.exact.user';
const password = 'synthetic-private-password';
async function fixture() {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const adapter = handle => ({ query: async (sql, params) => {
    const result = !params && /;\s*\S/.test(sql.trim().replace(/;$/, '')) ? (await handle.exec(sql)).at(-1) : await handle.query(sql, params);
    return { ...result, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
  } });
  const db = { ...adapter(pg), transaction: fn => pg.transaction(tx => fn(adapter(tx))) };
  await migrateDatabase(db);
  const source = randomUUID(), target = randomUUID(), plan = randomUUID(), subscription = randomUUID(), conversation = randomUUID(), message = randomUUID();
  await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Mensal',1,3000)", [plan]);
  await db.query(`INSERT INTO customers(id,name,whatsapp_e164,status,consent_contact,opt_out_at,portal_token_hash,portal_token_expires_at)
    VALUES($1,'Synthetic lead',$2,'lead',true,NULL,'source-legacy-token','2026-12-31')`, [source, phone]);
  await db.query(`INSERT INTO customers(id,name,status,bitpanel_reference,bitpanel_owner,access_password_encrypted,consent_contact,portal_token_hash,portal_token_expires_at)
    VALUES($1,'Synthetic imported','active',$2,'Gate One Pro Server',$3,false,'target-legacy-token','2026-12-31')`, [target, username, encryptSecret(password, config.COOKIE_SECRET)]);
  await db.query("INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id) VALUES($1,$2,$3,'2026-12-31','12345')", [subscription, target, plan]);
  await db.query(`INSERT INTO conversation_sessions(whatsapp_e164,state,data,expires_at,customer_id,conversation_id,context_state,handoff_status,pending_actions,revision)
    VALUES($1,'support',$2::jsonb,'2026-12-31',$3,$4,'HUMAN_HANDOFF','REQUESTED','{"preserved":true}',7)`,
  [phone, JSON.stringify({ customerId: source, support: 'preserve', untrustedField: 'not-an-identity' }), source, conversation]);
  await db.query(`INSERT INTO customer_identities(customer_id,identity_type,provider,external_id,normalized_value,verified_at,metadata)
    VALUES($1,'WHATSAPP','whatsapp_qr',$2,$2,'2026-10-01','{"preserve":true}')`, [source, phone]);
  const addMessage = async (patch = {}) => {
    const item = { id: randomUUID(), customer_id: source, conversation_id: conversation, direction: 'outbound', channel: 'whatsapp_qr',
      content: `Seu acesso\nLogin: ${username}\nSenha: ${password}`, provider_id: `3EB0${randomUUID().replaceAll('-', '')}`, status: 'sent', simulated: false,
      content_type: 'TEXT', processing_status: 'SENT', created_at: '2026-10-12T20:00:00.000Z', ...patch };
    await db.query(`INSERT INTO message_logs(id,customer_id,conversation_id,direction,channel,content,provider_id,status,simulated,content_type,processing_status,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, Object.values(item));return item.id;
  };
  await addMessage({ id: message });
  for (const customer of [source, target]) {
    await db.query(`INSERT INTO customer_portal_sessions(token_hash,customer_id,whatsapp_e164,expires_at) VALUES($1,$2,$3,'2026-12-31')`, [`session-${customer}`, customer, phone]);
    await db.query(`INSERT INTO customer_portal_links(token_hash,customer_id,whatsapp_e164,request_key,token_encrypted,expires_at)
      VALUES($1,$2,$3,'old-link','encrypted-synthetic-token','2026-12-31')`, [`link-${customer}`, customer, phone]);
  }
  const snapshot = async () => ({
    customers: (await db.query('SELECT id,whatsapp_e164,consent_contact,opt_out_at,portal_token_hash FROM customers ORDER BY id')).rows,
    financial: (await db.query(`SELECT (SELECT count(*) FROM charges)::int charges,(SELECT count(*) FROM payments)::int payments,
      (SELECT count(*) FROM renewal_jobs)::int renewals,(SELECT count(*) FROM notification_requests)::int notices,
      (SELECT count(*) FROM gate_event_outbox)::int outbox`)).rows[0],
    dates: (await db.query('SELECT id,expires_on::text,status FROM subscriptions ORDER BY id')).rows,
    messages: (await db.query('SELECT id,customer_id,content,provider_id,status FROM message_logs ORDER BY id')).rows
  });
  const run = patch => runWhatsAppIdentityScan({ db, config, now: () => new Date(clock), runtimeConfig: async () => config,
    readAccess: async (_runtime, binding) => ({ ...binding, password, sourceUrl: 'https://bitpanel.vip/list/view/12345', verifiedAt: clock.toISOString() }), ...patch });
  const apply = async patch => { const audit = await run();return run({ mode: 'apply', expectedAuditDigest: audit.auditDigest, ...patch }); };
  return { pg, db, source, target, plan, subscription, conversation, message, addMessage, snapshot, run, apply };
}

function assertNoSecrets(report) {
  const output = JSON.stringify(report);
  for (const value of [username, password, phone, config.COOKIE_SECRET, config.BITPANEL_STORAGE_STATE, 'source-legacy-token', 'target-legacy-token'])
    assert.equal(output.includes(value), false);
  assert.equal(report.realMessagesSent, 0);assert.equal(report.realChargesCreated, 0);assert.equal(report.realRenewals, 0);
}

test('offline audit identifies only complete sent credential pairs without provider calls, writes or secret output', async () => {
  const f = await fixture();try {
    const before = await f.snapshot();
    const report = await f.run({ readAccess: async () => assert.fail('offline audit must not read provider'), runtimeConfig: async () => assert.fail('no runtime in offline audit') });
    assert.equal(report.counts.completePairs, 1);assert.equal(report.counts.localMatches, 1);assert.equal(report.counts.freshPending, 1);
    assert.equal(report.counts.providerReads, 0);assert.deepEqual(report.maskedPhones, ['5511•••••9701']);
    assert.match(report.auditDigest, /^[a-f0-9]{64}$/);assertNoSecrets(report);assert.deepEqual(await f.snapshot(), before);
    assert.equal((await f.db.query('SELECT count(*)::int count FROM customer_identity_links')).rows[0].count, 0);
  } finally { await f.pg.close(); }
});

test('review reports contain only aggregated fixed reason codes without extra contact or credential data', async () => {
  const f = await fixture();try {
    await f.addMessage({ content: 'Login: another.exact.access\nSenha: another-private-password' });
    const before = await f.snapshot();
    const report = await f.run({ readAccess: async () => assert.fail('review audit must remain offline') });
    assert.equal(report.counts.reviewCandidates, 2);
    assert.deepEqual(report.reviewReasons, { multiple_accesses_for_phone: 2 });
    assert.equal(Object.values(report.reviewReasons).reduce((sum, count) => sum + count, 0), report.counts.reviewCandidates);
    assertNoSecrets(report);assert.equal(JSON.stringify(report).includes('another.exact.access'), false);
    assert.equal(JSON.stringify(report).includes('another-private-password'), false);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal((await f.db.query('SELECT count(*)::int count FROM customer_identity_links')).rows[0].count, 0);
  } finally { await f.pg.close(); }
});

test('fresh provider proof links an exact unique own access atomically, preserves both clients and historical messages and never grants consent', async () => {
  const f = await fixture();try {
    await f.db.query("UPDATE conversation_sessions SET updated_at='2026-10-12T17:00:00.000Z'");
    const before = await f.snapshot(), sessionBefore = (await f.db.query('SELECT * FROM conversation_sessions')).rows[0];
    const report = await f.apply();assert.equal(report.counts.applied, 1);assert.equal(report.counts.providerReads, 1);assertNoSecrets(report);
    const source = (await f.db.query('SELECT * FROM customers WHERE id=$1', [f.source])).rows[0];
    const target = (await f.db.query('SELECT * FROM customers WHERE id=$1', [f.target])).rows[0];
    assert.equal(source.whatsapp_e164, null);assert.equal(source.consent_contact, true);assert.equal(source.opt_out_at, null);
    assert.equal(target.whatsapp_e164, phone);assert.equal(target.consent_contact, false);assert.equal(target.portal_token_hash, null);
    assert.equal(decryptSecret(target.access_password_encrypted, config.COOKIE_SECRET), password);
    const session = (await f.db.query('SELECT * FROM conversation_sessions')).rows[0];
    for (const field of ['state', 'context_state', 'handoff_status', 'pending_actions', 'expires_at', 'last_activity_at', 'updated_at']) assert.deepEqual(session[field], sessionBefore[field]);
    assert.equal(session.customer_id, f.target);assert.equal(session.data.customerId, f.target);assert.equal(session.data.support, 'preserve');
    assert.equal(Number(session.revision), 8);
    const identity = (await f.db.query('SELECT * FROM customer_identities')).rows[0];
    assert.equal(identity.customer_id, f.target);assert.equal(identity.metadata.preserve, true);assert.equal(identity.metadata.historicalSourceCustomerId, f.source);
    assert.equal((await f.db.query('SELECT count(*)::int count FROM customer_portal_sessions')).rows[0].count, 0);
    assert.ok((await f.db.query('SELECT used_at FROM customer_portal_links')).rows.every(row => row.used_at));
    const link = (await f.db.query('SELECT * FROM customer_identity_links')).rows[0];assert.equal(link.status, 'confirmed');assert.equal(link.source_customer_id, f.source);
    const access = (await f.db.query('SELECT * FROM customer_access_sync')).rows[0];assert.equal(access.status, 'READY');assert.equal(access.verified_whatsapp_e164, phone);
    const audit = (await f.db.query('SELECT before_data,after_data FROM audit_logs')).rows;
    assert.equal(JSON.stringify(audit).includes(password), false);assert.equal(JSON.stringify(audit).includes(username), false);
    const after = await f.snapshot();assert.deepEqual(after.messages, before.messages);assert.deepEqual(after.dates, before.dates);assert.deepEqual(after.financial, before.financial);
    const again = await f.apply({ readAccess: async () => assert.fail('historical source cannot be linked twice') });assert.equal(again.counts.applied, 0);
  } finally { await f.pg.close(); }
});

test('multiple phones claiming one access get individual pending reviews without overwriting or approving existing reviews', async () => {
  const f = await fixture();try {
    const other = randomUUID(), conversation = randomUUID(), otherPhone = '5511999999702';
    await f.db.query(`INSERT INTO customers(id,name,whatsapp_e164,status,consent_contact)
      VALUES($1,'Other synthetic lead',$2,'lead',true)`, [other, otherPhone]);
    await f.db.query(`INSERT INTO conversation_sessions(whatsapp_e164,customer_id,conversation_id,data,expires_at)
      VALUES($1,$2,$3,$4::jsonb,'2026-12-31')`, [otherPhone, other, conversation, JSON.stringify({ customerId: other })]);
    await f.addMessage({ customer_id: other, conversation_id: conversation });
    const before = await f.snapshot();
    const report = await f.apply({ readAccess: async () => assert.fail('ambiguous phones must never read or approve provider access') });
    assert.equal(report.counts.queued, 2);assert.equal(report.counts.applied, 0);assert.equal(report.counts.snapshotChanged, 0);
    assert.deepEqual(report.reviewReasons, { multiple_phones_for_access: 2 });assertNoSecrets(report);
    const links = (await f.db.query('SELECT id,whatsapp_e164,status,reason FROM customer_identity_links ORDER BY whatsapp_e164')).rows;
    assert.equal(links.length, 2);assert.ok(links.every(link => link.status === 'pending' && link.reason === 'historical_scan_multiple_phones_for_access'));
    assert.deepEqual(await f.snapshot(), before);
    await f.db.query('DELETE FROM customer_identity_links WHERE whatsapp_e164=$1', [otherPhone]);
    const rerun = await f.apply({ readAccess: async () => assert.fail('a prior pending review cannot authorize assignment') });
    assert.equal(rerun.counts.queued, 1);assert.equal(rerun.counts.applied, 0);assert.equal(rerun.counts.providerReads, 0);
    const preserved = (await f.db.query('SELECT id,status,reason FROM customer_identity_links WHERE whatsapp_e164=$1', [phone])).rows[0];
    assert.deepEqual(preserved, { id: links[0].id, status: 'pending', reason: links[0].reason });
    const repeated = await f.apply();assert.equal(repeated.counts.queued, 0);assert.equal(repeated.counts.applied, 0);
    assert.equal((await f.db.query('SELECT count(*)::int count FROM customer_identity_links')).rows[0].count, 2);
  } finally { await f.pg.close(); }
});

test('capitalized, accented and emoji labels parse without modifying credential values or depending on display names',async()=>{
  const f=await fixture();try{
    await f.db.query('DELETE FROM message_logs');
    await f.addMessage({content:`👤 *Usuário:* ${username}\n🔑 **Senha:** ${password}`});
    const report=await f.run();assert.equal(report.counts.completePairs,1);assert.equal(report.counts.localMatches,1);assertNoSecrets(report);
    await f.db.query('DELETE FROM message_logs');
    await f.addMessage({content:`USERNAME: ${username}\nPASSWORD: ${password}`,status:'SENT'});
    assert.equal((await f.run()).counts.completePairs,1);
    await f.db.query('DELETE FROM message_logs');
    await f.addMessage({content:`⚠️ Mensagem encaminhada por outra pessoa\nLogin: ${username}\nSenha: ${password}`});
    assert.equal((await f.run()).counts.completePairs,0);
  }finally{await f.pg.close();}
});

test('no phone transfer can silently remove a global opt-out or upgrade contact permission',async()=>{
  for(const kind of ['opt-out-with-false-consent','opt-out-with-true-consent','consent-upgrade']){
    const f=await fixture();try{
      if(kind==='consent-upgrade')await f.db.query('UPDATE customers SET consent_contact=false WHERE id=$1',[f.source]);
      else await f.db.query("UPDATE customers SET opt_out_at='2026-10-01' WHERE id=$1",[f.source]);
      if(kind!=='opt-out-with-false-consent')await f.db.query('UPDATE customers SET consent_contact=true WHERE id=$1',[f.target]);
      const before=await f.snapshot(),report=await f.apply({readAccess:async()=>assert.fail('permission conflicts need human review')});
      assert.equal(report.counts.applied,0);assert.equal(report.counts.queued,1);assert.deepEqual(await f.snapshot(),before);assertNoSecrets(report);
      assert.equal((await f.db.query('SELECT reason FROM customer_identity_links')).rows[0].reason,'historical_scan_contact_permission_conflict');
    }finally{await f.pg.close();}
  }
});

test('a target phone identity or contradictory confirmed alias blocks assignment even when its phone column is empty',async()=>{
  for(const kind of ['target-identity','confirmed-alias']){
    const f=await fixture();try{
      if(kind==='target-identity')await f.db.query(`INSERT INTO customer_identities(customer_id,identity_type,provider,external_id,normalized_value)
        VALUES($1,'WHATSAPP','core','5511999999702','5511999999702')`,[f.target]);
      else await f.db.query(`INSERT INTO customer_identity_links(whatsapp_e164,source_customer_id,candidate_customer_id,claimed_login,status,reason)
        VALUES('5511999999702',$1,$2,$3,'confirmed','prior-proof')`,[f.source,f.target,username]);
      const report=await f.apply({readAccess:async()=>assert.fail('contradictory identity cannot be auto approved')});
      assert.equal(report.counts.applied,0);assert.equal(report.counts.queued,1);assertNoSecrets(report);
      assert.equal((await f.db.query('SELECT whatsapp_e164 FROM customers WHERE id=$1',[f.target])).rows[0].whatsapp_e164,null);
    }finally{await f.pg.close();}
  }
});

test('a historical message without its exact preserved conversation cannot use a later phone value as delivery proof',async()=>{
  for(const kind of ['no-conversation','wrong-conversation','missing-session']){
    const f=await fixture();try{
      if(kind==='no-conversation')await f.db.query('UPDATE message_logs SET conversation_id=NULL WHERE id=$1',[f.message]);
      if(kind==='wrong-conversation')await f.db.query('UPDATE message_logs SET conversation_id=$2 WHERE id=$1',[f.message,randomUUID()]);
      if(kind==='missing-session')await f.db.query('DELETE FROM conversation_sessions');
      const report=await f.apply({readAccess:async()=>assert.fail('current phone alone does not prove historical recipient')});
      assert.equal(report.counts.applied,0);assert.equal(report.counts.freshPending,0);assert.equal(report.counts.queued,1);assertNoSecrets(report);
    }finally{await f.pg.close();}
  }
});

test('new credential messages and changed provider authentication during a fresh read invalidate the pending decision under lock',async()=>{
  for(const kind of ['another-login-for-phone','same-login-for-another-phone','runtime-changed']){
    const f=await fixture();try{
      let runtime=config;
      const report=await f.apply({runtimeConfig:async()=>runtime,readAccess:async(_runtime,binding)=>{
        if(kind==='another-login-for-phone')await f.addMessage({content:'Login: another.exact.access\nSenha: another-secret',created_at:clock.toISOString()});
        if(kind==='same-login-for-another-phone'){
          const other=randomUUID();await f.db.query("INSERT INTO customers(id,name,status,whatsapp_e164) VALUES($1,'Other lead','lead','5511999999702')",[other]);
          await f.addMessage({customer_id:other,conversation_id:null,created_at:clock.toISOString()});
        }
        if(kind==='runtime-changed')runtime={...config,BITPANEL_STORAGE_STATE:'different-synthetic-session'};
        return{...binding,password,sourceUrl:'https://bitpanel.vip/list/view/12345',verifiedAt:clock.toISOString()};
      }});
      assert.equal(report.counts.applied,0);assert.equal(report.counts.snapshotChanged,1);assertNoSecrets(report);
      assert.equal((await f.db.query('SELECT whatsapp_e164 FROM customers WHERE id=$1',[f.target])).rows[0].whatsapp_e164,null);
      assert.equal((await f.db.query('SELECT count(*)::int count FROM customer_identity_links')).rows[0].count,0);
    }finally{await f.pg.close();}
  }
});

test('inbound claims, simulated or failed sends, forwarded/quoted text, split credentials and duplicate labels never authorize identity', async () => {
  const f = await fixture();try {
    await f.db.query('DELETE FROM message_logs');
    for (const patch of [{ direction: 'inbound' }, { simulated: true }, { status: 'queued' }, { provider_id: null }, { provider_id: 'SIM-WA-12345' },
      { content: `Encaminhada\nLogin: ${username}\nSenha: ${password}` }, { content: `> texto citado\nLogin: ${username}\nSenha: ${password}` },
      { content: `Login: ${username}` }, { content: `Senha: ${password}` }, { content: `Login: ${username}\nUsuário: ${username}\nSenha: ${password}` },
      { content: `Login: ${username}\nSenha: ${password}\nSenha: other-value` }]) await f.addMessage(patch);
    const report = await f.run();assert.equal(report.counts.completePairs, 0);assert.equal(report.counts.candidates, 0);assertNoSecrets(report);
  } finally { await f.pg.close(); }
});

test('conflicts with another phone, duplicated login or provider list and protected source history enter only pending review', async () => {
  for (const conflict of ['other-phone', 'duplicate-login', 'duplicate-list', 'source-subscription', 'wrong-stored-password']) {
    const f = await fixture();try {
      if (conflict === 'other-phone') await f.db.query("UPDATE customers SET whatsapp_e164='5511999999702' WHERE id=$1", [f.target]);
      if (conflict === 'duplicate-login') await f.db.query("INSERT INTO customers(name,bitpanel_reference) VALUES('Other',$1)", [username.toUpperCase()]);
      if (conflict === 'duplicate-list') {
        const other = randomUUID();await f.db.query("INSERT INTO customers(id,name) VALUES($1,'Other')", [other]);
        await f.db.query("INSERT INTO subscriptions(customer_id,plan_id,expires_on,bitpanel_list_id) VALUES($1,$2,'2026-12-31','12345')", [other, f.plan]);
      }
      if (conflict === 'source-subscription') await f.db.query("INSERT INTO subscriptions(customer_id,plan_id,expires_on) VALUES($1,$2,'2026-12-31')", [f.source, f.plan]);
      if (conflict === 'wrong-stored-password') await f.db.query('UPDATE customers SET access_password_encrypted=$2 WHERE id=$1', [f.target, encryptSecret('different-password', config.COOKIE_SECRET)]);
      const before = await f.snapshot(), report = await f.apply({ readAccess: async () => assert.fail('known conflicts cannot read or approve provider access') });
      assert.equal(report.counts.applied, 0);assert.equal(report.counts.queued, 1);assertNoSecrets(report);
      assert.deepEqual(await f.snapshot(), before);
      const links = (await f.db.query('SELECT status,reason FROM customer_identity_links')).rows;assert.equal(links.length, 1);assert.equal(links[0].status, 'pending');
      const replay = await f.apply();assert.equal(replay.counts.applied, 0);assert.equal((await f.db.query('SELECT count(*)::int count FROM customer_identity_links')).rows[0].count, 1);
    } finally { await f.pg.close(); }
  }
});

test('an already linked owner is read-only and missing legacy ciphertext still needs exact fresh provider password proof', async () => {
  const f = await fixture();try {
    await f.db.query('UPDATE customers SET whatsapp_e164=NULL WHERE id=$1', [f.source]);
    await f.db.query('UPDATE customers SET whatsapp_e164=$2 WHERE id=$1', [f.target, phone]);
    await f.db.query('UPDATE message_logs SET customer_id=$2,conversation_id=NULL WHERE id=$1', [f.message, f.target]);
    await f.db.query('DELETE FROM conversation_sessions');
    const report = await f.apply({ readAccess: async () => assert.fail('already linked needs no provider read') });
    assert.equal(report.counts.alreadyLinked, 1);assert.equal(report.counts.applied, 0);assertNoSecrets(report);
  } finally { await f.pg.close(); }
  const missing = await fixture();try {
    await missing.db.query('UPDATE customers SET access_password_encrypted=NULL WHERE id=$1', [missing.target]);
    const audit = await missing.run();assert.equal(audit.counts.localMatches, 0);assert.equal(audit.counts.freshPending, 1);
    const report = await missing.apply();assert.equal(report.counts.applied, 1);assertNoSecrets(report);
  } finally { await missing.pg.close(); }
});

test('provider failure or stale/mismatched proof cannot link or reveal credentials', async () => {
  for (const proof of ['failure', 'password', 'username', 'list', 'owner', 'source', 'stale', 'future']) {
    const f = await fixture();try {
      const before = await f.snapshot();const report = await f.apply({ readAccess: async (_runtime, binding) => {
        if (proof === 'failure') throw Error(`private ${password} ${username}`);
        return { ...binding, password, sourceUrl: 'https://bitpanel.vip/list/view/12345', verifiedAt: clock.toISOString(),
          ...(proof === 'password' ? { password: 'different-password' } : proof === 'username' ? { username: 'other.user' } :
            proof === 'list' ? { listId: '99999' } : proof === 'owner' ? { owner: 'Other reseller' } :
              proof === 'source' ? { sourceUrl: 'https://other.net/list/view/12345' } : proof === 'stale' ? { verifiedAt: '2026-10-12T23:00:00.000Z' } :
                { verifiedAt: '2026-10-13T01:00:00.001Z' }) };
      } });
      assert.equal(report.counts.applied, 0);assertNoSecrets(report);assert.deepEqual(await f.snapshot(), before);
      if (proof === 'failure') { assert.equal(report.counts.readFailures, 1);assert.equal(report.counts.queued, 0); }
      else assert.equal(report.counts.queued, 1);
    } finally { await f.pg.close(); }
  }
});

test('digest and transaction rechecks stop stale evidence; an audit failure rolls back phone, aliases and token invalidation', async () => {
  const f = await fixture();try {
    const audit = await f.run();await f.db.query('UPDATE message_logs SET content=$2 WHERE id=$1', [f.message, `Login: ${username}\nSenha: changed-private-value`]);
    await assert.rejects(f.run({ mode: 'apply', expectedAuditDigest: audit.auditDigest }), { code: 'IDENTITY_SCAN_AUDIT_CHANGED' });
    await assert.rejects(f.run({ mode: 'apply' }), { code: 'IDENTITY_SCAN_AUDIT_REQUIRED' });
  } finally { await f.pg.close(); }
  const changed = await fixture();try {
    const report = await changed.apply({ readAccess: async (_runtime, binding) => {
      await changed.db.query("UPDATE customers SET whatsapp_e164='5511999999711' WHERE id=$1", [changed.source]);
      return { ...binding, password, sourceUrl: 'https://bitpanel.vip/list/view/12345', verifiedAt: clock.toISOString() };
    } });assert.equal(report.counts.applied, 0);assert.equal(report.counts.snapshotChanged, 1);assertNoSecrets(report);
  } finally { await changed.pg.close(); }
  const rollback = await fixture();try {
    const before = await rollback.snapshot(), audit = await rollback.run();
    const db = { ...rollback.db, transaction: fn => rollback.db.transaction(client => fn({ query: async (sql, params) => {
      if (sql.includes('INSERT INTO audit_logs')) throw Error(`private ${password}`);return client.query(sql, params);
    } })) };
    const report = await rollback.run({ db, mode: 'apply', expectedAuditDigest: audit.auditDigest });
    assert.equal(report.counts.transactionFailures, 1);assert.equal(report.counts.applied, 0);assertNoSecrets(report);
    assert.deepEqual(await rollback.snapshot(), before);
    assert.equal((await rollback.db.query('SELECT count(*)::int count FROM customer_identity_links')).rows[0].count, 0);
    assert.equal((await rollback.db.query('SELECT count(*)::int count FROM customer_portal_sessions')).rows[0].count, 2);
  } finally { await rollback.pg.close(); }
});

test('CLI only accepts exact production and SHA with a prior audit digest for apply', () => {
  const sha = 'a'.repeat(40), audit = 'b'.repeat(64);
  const env = { RAILWAY_PROJECT_ID: 'a0f107fe-acaf-459f-a640-38ef6010d1e5', RAILWAY_ENVIRONMENT_ID: '697f58fb-5084-4cb3-bd9a-ecdbc921b7bc', RAILWAY_GIT_COMMIT_SHA: sha };
  assert.deepEqual(parseWhatsAppIdentityScanArgs(['--dry-run', '--expected-sha', sha]), { mode: 'dry-run', expectedSha: sha });
  assert.deepEqual(parseWhatsAppIdentityScanArgs(['--apply', '--expected-sha', sha, '--audit-digest', audit]), { mode: 'apply', expectedSha: sha, expectedAuditDigest: audit });
  for (const args of [[], ['--apply', '--expected-sha', sha], ['--dry-run', '--apply', '--expected-sha', sha], ['--dry-run', '--expected-sha', sha, '--force']])
    assert.throws(() => parseWhatsAppIdentityScanArgs(args), { code: 'IDENTITY_SCAN_ARGUMENTS_INVALID' });
  assert.doesNotThrow(() => assertWhatsAppIdentityScanEnvironment({ env, expectedSha: sha }));
  for (const [field, code] of [['RAILWAY_PROJECT_ID', 'IDENTITY_SCAN_PROJECT_MISMATCH'], ['RAILWAY_ENVIRONMENT_ID', 'IDENTITY_SCAN_ENVIRONMENT_MISMATCH'], ['RAILWAY_GIT_COMMIT_SHA', 'IDENTITY_SCAN_VERSION_MISMATCH']])
    assert.throws(() => assertWhatsAppIdentityScanEnvironment({ env: { ...env, [field]: 'other' }, expectedSha: sha }), { code });
});
