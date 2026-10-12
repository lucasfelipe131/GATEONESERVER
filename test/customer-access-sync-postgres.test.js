import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {CustomerAccessSync} from '../src/services/customer-access-sync.js';
import {decryptSecret,encryptSecret} from '../src/security.js';

const config={COOKIE_SECRET:'synthetic-customer-access-encryption-secret',BITPANEL_BASE_URL:'https://bitpanel.vip',BITPANEL_MODE:'disabled'};
async function fixture(){
  const pg=new PGlite({extensions:{pgcrypto}});
  const adapter=handle=>({query:async(sql,params)=>{const result=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await handle.exec(sql)).at(-1):await handle.query(sql,params);return{...result,rowCount:result.rowCount??result.affectedRows??result.rows.length};}});
  const db={...adapter(pg),transaction:fn=>pg.transaction(tx=>fn(adapter(tx)))};
  await migrateDatabase(db);
  const plan=randomUUID(),one=randomUUID(),two=randomUUID(),subscriptionOne=randomUUID(),subscriptionTwo=randomUUID();
  await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Mensal',1,3000)",[plan]);
  for(const [id,phone,username,listId,subscription] of [[one,'5511999999701','customer.one','12345',subscriptionOne],[two,'5511999999702','customer.two','56789',subscriptionTwo]]){
    await db.query(`INSERT INTO customers(id,name,whatsapp_e164,bitpanel_reference,bitpanel_owner,access_password_encrypted) VALUES($1,'Synthetic customer',$2,$3,'Gate One Pro Server',$4)`,[id,phone,username,encryptSecret('legacy-unverified',config.COOKIE_SECRET)]);
    await db.query("INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id) VALUES($1,$2,$3,'2026-12-31',$4)",[subscription,id,plan,listId]);
  }
  const service=(patch={})=>new CustomerAccessSync({db,config,runtimeConfig:async()=>config,readInformation:null,
    readAccess:async(_runtime,binding)=>({...binding,password:`synthetic-${binding.listId}`,sourceUrl:`https://bitpanel.vip/list/view/${binding.listId}`}),...patch});
  const enable=()=>db.query("UPDATE system_settings SET value='true'::jsonb WHERE key='bitpanel_read_sync_enabled'");
  const counts=async()=>{
    const row=(await db.query(`SELECT (SELECT count(*) FROM charges)::int AS charges,(SELECT count(*) FROM renewal_jobs)::int AS renewals,
      (SELECT count(*) FROM message_logs)::int AS messages,(SELECT count(*) FROM payments)::int AS payments,
      (SELECT count(*) FROM notification_requests)::int AS notices,(SELECT count(*) FROM gate_event_outbox)::int AS outbox`)).rows[0];
    const dates=(await db.query('SELECT id,expires_on::text FROM subscriptions ORDER BY id')).rows;return{...row,dates};
  };
  const expireAttempts=()=>db.query("UPDATE customer_access_sync SET attempted_at=now()-interval '16 minutes'");
  return{db,pg,one,two,subscriptionOne,subscriptionTwo,service,enable,counts,expireAttempts};
}

test('read sync is disabled by default; legacy passwords are unavailable; verified credentials stay isolated and encrypted without financial actions',async()=>{
  const f=await fixture();try{
    const before=await f.counts();let reads=0;
    const service=f.service({readAccess:async(_runtime,binding)=>{reads++;return{...binding,password:`synthetic-${binding.listId}`,sourceUrl:`https://bitpanel.vip/list/view/${binding.listId}`};}});
    assert.deepEqual(await service.sync(),{enabled:false,checked:0,synced:0});assert.equal(reads,0);
    assert.equal((await service.metadata(f.one)).passwordAvailable,false);
    await assert.rejects(service.reveal(f.one),{code:'CUSTOMER_ACCESS_UPDATE_REQUIRED'});
    await f.enable();const report=await service.sync({limit:20});assert.equal(report.synced,2);assert.equal(reads,2);
    assert.equal((await service.metadata(f.one)).status,'READY');assert.equal((await service.metadata(f.one)).passwordAvailable,true);
    assert.equal((await service.reveal(f.one)).password,'synthetic-12345');assert.equal((await service.reveal(f.two)).password,'synthetic-56789');
    assert.equal((await service.reveal(f.one)).expiresInSeconds,60);
    const stored=(await f.db.query('SELECT access_password_encrypted FROM customers WHERE id=$1',[f.one])).rows[0].access_password_encrypted;
    assert.ok(stored.startsWith('v1.'));assert.equal(stored.includes('synthetic-12345'),false);assert.equal(decryptSecret(stored,config.COOKIE_SECRET),'synthetic-12345');
    const metadata=await service.metadata(f.one);assert.equal(metadata.password,undefined);assert.equal(metadata.access_password_encrypted,undefined);
    assert.equal((await service.sync()).checked,0);assert.equal(reads,2);
    assert.deepEqual(await f.counts(),before);
    const record=(await f.db.query('SELECT * FROM customer_access_sync WHERE customer_id=$1',[f.one])).rows[0];assert.equal(record.password,undefined);
    assert.equal(JSON.stringify(record).includes('synthetic-12345'),false);
  }finally{await f.pg.close();}
});

test('customer relinking during a provider read prevents writing credentials; exact ownership and conflicts fail closed',async()=>{
  const f=await fixture();try{
    await f.enable();const before=await f.counts();let reads=0;
    const service=f.service({readAccess:async(_runtime,binding)=>{
      reads++;if(binding.listId==='12345')await f.db.query("UPDATE customers SET whatsapp_e164='5511999999711' WHERE id=$1",[f.one]);
      return{...binding,password:'must-not-be-written',sourceUrl:`https://bitpanel.vip/list/view/${binding.listId}`};
    }});
    const report=await service.sync({limit:20});assert.equal(report.unverified,1);
    assert.equal((await service.metadata(f.one)).passwordAvailable,false);
    assert.equal(decryptSecret((await f.db.query('SELECT access_password_encrypted FROM customers WHERE id=$1',[f.one])).rows[0].access_password_encrypted,config.COOKIE_SECRET),'legacy-unverified');
    await f.db.query("UPDATE customers SET bitpanel_owner='Other reseller' WHERE id=$1",[f.one]);await f.expireAttempts();
    reads=0;await service.sync({limit:20});assert.equal(reads,1);assert.equal((await service.metadata(f.one)).status,'UNVERIFIED_LINK');
    await f.db.query("UPDATE customers SET bitpanel_owner='Gate One Pro Server',bitpanel_reference='customer.two' WHERE id=$1",[f.one]);await f.expireAttempts();
    reads=0;await service.sync({limit:20});assert.equal(reads,0);assert.equal((await service.metadata(f.two)).passwordAvailable,false);
    await assert.rejects(service.reveal(f.two),{code:'CUSTOMER_ACCESS_UPDATE_REQUIRED'});
    assert.deepEqual(await f.counts(),before);
  }finally{await f.pg.close();}
});

test('credentials older than 24 hours cannot be revealed; reauthentication and provider errors disclose no dynamic details',async()=>{
  const f=await fixture();try{
    await f.enable();const service=f.service();await service.sync({limit:20});
    await f.db.query("UPDATE customer_access_sync SET verified_at=now()-interval '25 hours'");
    assert.equal((await service.metadata(f.one)).status,'STALE');assert.equal((await service.metadata(f.one)).passwordAvailable,false);
    await assert.rejects(service.reveal(f.one),{code:'CUSTOMER_ACCESS_UPDATE_REQUIRED'});
    await f.expireAttempts();const reauth=f.service({readAccess:async()=>{throw Object.assign(Error('private password should not reach logs'),{code:'BITPANEL_READ_REAUTH_REQUIRED'});}});
    assert.equal((await reauth.sync({limit:20})).reauthRequired,2);
    assert.equal((await reauth.metadata(f.one)).status,'REAUTH_REQUIRED');assert.equal((await reauth.metadata(f.one)).passwordAvailable,false);
    const errors=(await f.db.query('SELECT last_error_code FROM customer_access_sync')).rows;assert.ok(errors.every(row=>row.last_error_code==='BITPANEL_READ_REAUTH_REQUIRED'));
    await f.expireAttempts();const unavailable=f.service({readAccess:async()=>{throw Error('dynamic username credential response');}});
    assert.equal((await unavailable.sync({limit:20})).stale,2);
    assert.ok((await f.db.query('SELECT last_error_code FROM customer_access_sync')).rows.every(row=>row.last_error_code==='BITPANEL_READ_UNAVAILABLE'));
  }finally{await f.pg.close();}
});

test('read sync serializes worker replicas, obeys batch bounds, and never looks up a pending claimed login',async()=>{
  const f=await fixture();try{
    await f.enable();const before=await f.counts();let release,entered;
    const started=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
    const first=f.service({readAccess:async(_runtime,binding)=>{entered();await blocked;return{...binding,password:'bounded-synthetic',sourceUrl:`https://bitpanel.vip/list/view/${binding.listId}`};}});
    await f.db.query("INSERT INTO customer_identity_links(whatsapp_e164,source_customer_id,claimed_login,status,reason) VALUES('5511999999701',$1,'someone.else','pending','portal_identity_claim')",[f.one]);
    const job=first.sync({limit:1});await started;
    assert.equal((await f.service().sync()).busy,true);release();const report=await job;assert.equal(report.checked,1);assert.equal(report.synced,1);
    assert.deepEqual(await f.counts(),before);
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM customer_access_sync_lease')).rows[0].count,0);
  }finally{await f.pg.close();}
});

test('a batch of five prioritizes an eligible linked Gate One customer before six unverified candidates',async()=>{
  const f=await fixture();try{
    await f.enable();
    await f.db.query("UPDATE customers SET bitpanel_owner='Other reseller' WHERE id IN ($1,$2)",[f.one,f.two]);
    const plan=(await f.db.query('SELECT id FROM plans')).rows[0].id;
    const eligible='ffffffff-ffff-4fff-8fff-fffffffffff0';
    const invalid=Array.from({length:4},(_unused,index)=>`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`);
    for(const [index,id] of [...invalid,eligible].entries()){
      await f.db.query(`INSERT INTO customers(id,name,whatsapp_e164,bitpanel_reference,bitpanel_owner,automation_eligible)
        VALUES($1,'Synthetic batch priority',$2,$3,$4,true)`,[id,`55119999998${String(index).padStart(2,'0')}`,
        `batch.customer${index}`,id===eligible?' GÁTE - ONE PRO SERVER ':'Other reseller']);
      await f.db.query("INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id) VALUES($1,$2,$3,'2026-12-31',$4)",
        [randomUUID(),id,plan,String(90000+index)]);
    }
    const before=await f.counts(),reads=[];
    const service=f.service({readAccess:async(_runtime,binding)=>{
      reads.push(binding.listId);
      return{...binding,password:'synthetic-priority',sourceUrl:`https://bitpanel.vip/list/view/${binding.listId}`};
    }});
    const report=await service.sync({limit:5});
    assert.equal(report.checked,5);assert.equal(report.synced,1);assert.equal(report.unverified,4);
    assert.deepEqual(reads,['90004']);
    assert.equal((await service.metadata(eligible)).status,'READY');
    assert.equal((await f.db.query("SELECT count(*)::int n FROM customer_access_sync WHERE status='UNVERIFIED_LINK'")).rows[0].n,4);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM customers')).rows[0].n,7);
    assert.deepEqual(await f.counts(),before);
  }finally{await f.pg.close();}
});

test('authenticated provider content replaces only its own posts, preserves apps and marks cached DNS stale on failure',async()=>{
  const f=await fixture();try{
    await f.enable();const before=await f.counts(),verifiedAt=new Date().toISOString();
    const previous={suggestedApps:[{device:'lg',name:'Reviewed app'}],posts:[{source:'telegram',title:'Preserved'}]};
    await f.db.query("INSERT INTO system_settings(key,value) VALUES('customer_help_catalog',$1::jsonb)",[JSON.stringify(previous)]);
    const reader=f.service({readInformation:async()=>({source:'https://bitpanel.vip/notices',posts:[{source:'bitpanel',category:'notices',title:'Provider notice',content:'Reviewed content',url:'https://bitpanel.vip/notices',verifiedAt}],
      dns:[{name:'DNS atual',value:'http://auth.urlcld.com',status:'READY',verifiedAt,sourceUrl:'https://bitpanel.vip/notices'}],dnsVerified:true,
      telegram:{channelUrl:'https://t.me/+OkM9So6d9npjODRh',verifiedAt,sourceUrl:'https://bitpanel.vip/'},downloadsUrl:'https://bitplatform.vip/'})});
    assert.equal((await reader.syncInformation(config)).status,'READY');
    const current=(await f.db.query("SELECT value FROM system_settings WHERE key='customer_help_catalog'")).rows[0].value;
    assert.deepEqual(current.suggestedApps,previous.suggestedApps);assert.equal(current.posts.length,2);assert.equal(current.dns.length,1);
    const broken=f.service({readInformation:async()=>{throw Object.assign(Error('private details'),{code:'BITPANEL_READ_REAUTH_REQUIRED'});}});
    assert.equal((await broken.syncInformation(config)).status,'REAUTH_REQUIRED');
    const after=(await f.db.query("SELECT value FROM system_settings WHERE key='customer_help_catalog'")).rows[0].value;
    assert.equal(after.dns[0].value,'http://auth.urlcld.com');assert.equal(after.dns[0].status,'STALE');assert.deepEqual(after.posts,current.posts);
    assert.equal(after.bitpanelSync.lastErrorCode,'BITPANEL_READ_REAUTH_REQUIRED');assert.equal(JSON.stringify(after).includes('private details'),false);
    assert.deepEqual(await f.counts(),before);
  }finally{await f.pg.close();}
});
