import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {assertCustomerHubReadProofEnvironment,runCustomerHubReadProof} from '../scripts/customer-hub-read-proof.js';

test('read proof requires the exact production identity and commit',()=>{
  const expectedSha='a'.repeat(40),env={RAILWAY_PROJECT_ID:'a0f107fe-acaf-459f-a640-38ef6010d1e5',
    RAILWAY_ENVIRONMENT_ID:'697f58fb-5084-4cb3-bd9a-ecdbc921b7bc',RAILWAY_GIT_COMMIT_SHA:expectedSha};
  assert.doesNotThrow(()=>assertCustomerHubReadProofEnvironment({env,expectedSha}));
  for(const [key,code] of [['RAILWAY_PROJECT_ID','READ_PROOF_PROJECT_MISMATCH'],
    ['RAILWAY_ENVIRONMENT_ID','READ_PROOF_ENVIRONMENT_MISMATCH'],['RAILWAY_GIT_COMMIT_SHA','READ_PROOF_VERSION_MISMATCH']])
    assert.throws(()=>assertCustomerHubReadProofEnvironment({env:{...env,[key]:'wrong'},expectedSha}),{code});
});

test('read proof caches only verified access and previews four calendars without financial, message or settings writes',async t=>{
  const pg=new PGlite({extensions:{pgcrypto}}),adapt=handle=>({query:async(sql,params)=>{
    const r=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await handle.exec(sql)).at(-1):await handle.query(sql,params);
    return{...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};
  }}),db={...adapt(pg),transaction:fn=>pg.transaction(tx=>fn(adapt(tx)))};
  const config={COOKIE_SECRET:'synthetic-proof-encryption-secret',BITPANEL_BASE_URL:'https://bitpanel.vip',
    BITPANEL_MODE:'disabled',BITPANEL_PLAN_LABEL:'30, R$ 30,00',TIMEZONE:'America/Sao_Paulo',
    BITPANEL_STORAGE_STATE:JSON.stringify({cookies:[],origins:[]})};
  const now=()=>new Date('2026-10-12T15:00:00.000Z');
  const planIds={};
  const counts=async()=>({financial:(await db.query(`SELECT (SELECT count(*) FROM charges)::int charges,
    (SELECT count(*) FROM renewal_jobs)::int renewals,(SELECT count(*) FROM payments)::int payments,
    (SELECT count(*) FROM message_logs)::int messages,(SELECT count(*) FROM gate_event_outbox)::int outbox,
    (SELECT count(*) FROM notification_requests)::int notices`)).rows[0],
    dates:(await db.query('SELECT id,expires_on::text FROM subscriptions ORDER BY id')).rows,
    settings:(await db.query('SELECT key,value FROM system_settings ORDER BY key')).rows});
  const information=()=>({source:'https://bitpanel.vip/notices',status:'READY',verifiedAt:now().toISOString(),posts:[
    {source:'bitpanel',title:'Aviso de demonstração',content:'Aviso sintético.',url:'https://bitpanel.vip/notices',
      publishedAt:'2026-10-08T03:13:00.000Z',verifiedAt:now().toISOString()},
    {source:'bitpanel',title:'Novidade de demonstração',content:'Novidade sintética.',url:'https://bitpanel.vip/news',
      publishedAt:'2026-10-05T01:39:00.000Z',verifiedAt:now().toISOString()}],
    dnsVerified:true,dns:[{name:'DNS de demonstração',value:'http://auth.urlcld.com',status:'READY',
      sourceUrl:'https://bitpanel.vip/notices',verifiedAt:now().toISOString()}]});
  const provider=({mismatch=[],readError}={})=>{
    const calls={connection:0,access:[],previews:[]};
    return{calls,testConnection:async()=>{calls.connection++;return{ok:true};},readInformation:async()=>information(),
      readAccess:async(_runtime,binding)=>{
        calls.access.push(binding.listId);if(readError)throw readError;
        return{...binding,password:`synthetic-password-${binding.listId}`,sourceUrl:`https://bitpanel.vip/list/view/${binding.listId}`};
      },previewRenewal:async(runtime,renewal)=>{
        calls.previews.push(renewal);
        assert.equal(runtime.BITPANEL_MODE,'disabled');assert.equal(runtime.BITPANEL_PLAN_LABEL,config.BITPANEL_PLAN_LABEL);
        assert.equal(runtime.BITPANEL_AUTOMATIC_RENEWAL_POLICY.planLabel,'30');
        if(mismatch.includes(renewal.bitpanel_list_id))throw Object.assign(Error('Sensitive provider response'),{code:'RENEWAL_PROVIDER_EXPIRATION_MISMATCH'});
        const months=renewal.duration_months;
        return{prepared:true,submitted:false,balance:{status:'verified',availableCredits:90,sufficient:true},quote:{listId:renewal.bitpanel_list_id,planLabel:'30',months,connections:1,
          credits:months,unitPriceCents:3000,totalPriceCents:3000*months},sourceUrl:`https://bitpanel.vip/list/view/${renewal.bitpanel_list_id}`};
      }};
  };
  const run=patch=>runCustomerHubReadProof({db,config,runtimeConfig:async()=>config,now,...patch});
  const fetchBefore=globalThis.fetch;let networkCalls=0;
  try{
    await migrateDatabase(db);
    globalThis.fetch=async()=>{networkCalls++;throw Error('NETWORK_FORBIDDEN_IN_READ_PROOF_TEST');};
    for(const [code,months,price] of [['monthly',1,3000],['quarterly',3,8500],['semiannual',6,15000],['annual',12,27000]]){
      planIds[code]=randomUUID();await db.query('INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,$2,$2,$3,$4)',[planIds[code],code,months,price]);
    }
    for(let index=1;index<=5;index++){
      const customer=`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
      await db.query(`INSERT INTO customers(id,name,whatsapp_e164,bitpanel_reference,bitpanel_owner,automation_eligible)
        VALUES($1,'Synthetic proof',$2,$3,' GÁTE - ONE PRO SERVER ',true)`,[customer,`55119999995${String(index).padStart(2,'0')}`,`synthetic.user${index}`]);
      await db.query('INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(),customer,planIds.monthly,index===2?'2026-10-01':'2099-01-31',String(9000+index)]);
    }
    await db.query(`INSERT INTO customers(id,name,whatsapp_e164,bitpanel_reference,bitpanel_owner,automation_eligible)
      VALUES($1,'Synthetic conflicting owner','5511999999599','synthetic.user1','Other reseller',false)`,[randomUUID()]);
    const before=await counts();
    await t.test('skips conflicts, retries a stale expiry and proves all four plans on one customer without revealing identity',async()=>{
      const injected=provider({mismatch:['9002']}),proof=await run(injected);
      assert.equal(proof.proved,true);assert.equal(proof.proofs.customerAccess.conflictsSkipped,1);
      assert.equal(proof.proofs.customerAccess.attempted,2);assert.equal(proof.proofs.customerAccess.cached,2);
      assert.equal(proof.proofs.renewalPreview.validated,4);assert.equal(proof.proofs.renewalPreview.submitted,0);
      assert.equal(proof.proofs.content.status,'READY');assert.equal(proof.proofs.content.posts,2);assert.equal(proof.proofs.content.dns,1);
      assert.deepEqual(injected.calls.access,['9002','9003']);assert.equal(injected.calls.previews[0].expected_expiration,'2026-11-12');
      assert.deepEqual(injected.calls.previews.slice(1).map(row=>row.expected_expiration),['2099-02-28','2099-04-30','2099-07-31','2100-01-31']);
      assert.ok(injected.calls.previews.slice(1).every(row=>row.bitpanel_list_id==='9003'));
      const output=JSON.stringify(proof);for(const secret of ['synthetic.user','synthetic-password','55119999995','/list/view/'])assert.equal(output.includes(secret),false);
      const cache=(await db.query("SELECT status FROM customer_access_sync")).rows;assert.equal(cache.length,2);assert.ok(cache.every(row=>row.status==='READY'));
      assert.deepEqual(await counts(),before);
    });
    await t.test('failed content or absent protected session cannot yield a successful proof or read customer credentials',async()=>{
      const absent=provider(),missing=await run({...absent,runtimeConfig:async()=>({...config,BITPANEL_STORAGE_STATE:null})});
      assert.equal(missing.proved,false);assert.equal(missing.failures.READ_PROOF_SESSION_REQUIRED,1);assert.equal(absent.calls.connection,0);
      const broken=provider(),proof=await run({...broken,readInformation:async()=>({...information(),dnsVerified:false})});
      assert.equal(proof.proved,false);assert.equal(proof.failures.READ_PROOF_CONTENT_UNAVAILABLE,1);assert.equal(broken.calls.access.length,0);
      assert.deepEqual(await counts(),before);
    });
    await t.test('three mismatching customers exhaust the bound and dynamic errors are replaced by fixed codes',async()=>{
      const injected=provider({mismatch:['9002','9003','9004','9005']}),proof=await run(injected);
      assert.equal(proof.proved,false);assert.deepEqual(injected.calls.access,['9002','9003','9004']);
      assert.equal(proof.failures.RENEWAL_PROVIDER_EXPIRATION_MISMATCH,3);assert.equal(proof.failures.READ_PROOF_NO_VERIFIED_CUSTOMER,1);
      const unavailable=await run(provider({readError:Error('private username password and phone')}));
      assert.equal(unavailable.proved,false);assert.equal(unavailable.failures.READ_PROOF_UNAVAILABLE,1);
      assert.equal(JSON.stringify(unavailable).includes('private username'),false);assert.deepEqual(await counts(),before);
    });
    assert.equal(networkCalls,0);
  }finally{globalThis.fetch=fetchBefore;await pg.close();}
});
