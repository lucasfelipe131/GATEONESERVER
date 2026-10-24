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
    await t.test('only the eight safe posts from a ten-post read are proved and cached; blocked text never reaches output or cache',async()=>{
      const raw=information(),notice=raw.posts[0],news=raw.posts[1],secret='synthetic-private-content-never-cache';
      raw.posts.push(...Array.from({length:6},(_,index)=>({...(index<2?notice:news),
        title:`Atualização pública ${index+1}`,content:index<2?'Aviso público de manutenção programada.':'Novidade pública de aplicativos.'})),
        {...notice,title:'Aviso protegido',content:`<script>${secret}</script>`},
        {...notice,title:'Outro aviso protegido',content:`Senha: ${secret}`});
      const expectedSha='a'.repeat(40),env={RAILWAY_PROJECT_ID:'a0f107fe-acaf-459f-a640-38ef6010d1e5',
        RAILWAY_ENVIRONMENT_ID:'697f58fb-5084-4cb3-bd9a-ecdbc921b7bc',RAILWAY_GIT_COMMIT_SHA:expectedSha};
      const previous=(await db.query("SELECT value FROM system_settings WHERE key='customer_help_catalog'")).rows[0];
      try {
        const injected=provider(),proof=await run({...injected,readInformation:async()=>raw,cacheContent:true,expectedSha,env});
        assert.equal(proof.proved,true);assert.equal(proof.proofs.content.cacheStatus,'READY');
        for(const [key,value] of Object.entries({rawPosts:10,acceptedPosts:8,rejectedPosts:2,acceptedNotices:3,acceptedNews:5,rejectedNotices:2,rejectedNews:0,posts:8,dns:1}))
          assert.equal(proof.proofs.content[key],value);
        const catalog=(await db.query("SELECT value FROM system_settings WHERE key='customer_help_catalog'")).rows[0].value;
        assert.equal(catalog.posts.length,8);assert.ok(catalog.posts.every(post=>post.source==='bitpanel'));
        assert.deepEqual(catalog.dns,raw.dns);assert.equal(JSON.stringify(catalog).includes(secret),false);
        assert.equal(JSON.stringify(proof).includes(secret),false);assert.equal(JSON.stringify(proof).includes('<script>'),false);
        assert.equal(proof.proofs.renewalPreview.submitted,0);assert.equal(proof.realTestCharges,0);assert.equal(proof.realTestMessages,0);assert.equal(proof.realTestRenewals,0);
      } finally {
        if(previous)await db.query("UPDATE system_settings SET value=$1::jsonb WHERE key='customer_help_catalog'",[JSON.stringify(previous.value)]);
        else await db.query("DELETE FROM system_settings WHERE key='customer_help_catalog'");
      }
      assert.deepEqual(await counts(),before);
    });
    await t.test('a missing safe source, stale post or partially rejected DNS remains blocked before any customer read',async()=>{
      const patches=[info=>({...info,posts:info.posts.filter(post=>post.url.endsWith('/notices'))}),
        info=>({...info,posts:info.posts.filter(post=>post.url.endsWith('/news'))}),
        info=>({...info,posts:info.posts.map(post=>post.url.endsWith('/news')?{...post,content:'senha: private'}:post)}),
        info=>({...info,posts:info.posts.map(post=>post.url.endsWith('/news')?{...post,verifiedAt:new Date(now().getTime()-60_001).toISOString()}:post)}),
        info=>({...info,dns:[...info.dns,{...info.dns[0],value:'http://localhost'}]}),
        info=>({...info,dns:info.dns.map(dns=>({...dns,verifiedAt:new Date(now().getTime()-60_001).toISOString()}))})];
      for(const patch of patches) {
        const injected=provider(),proof=await run({...injected,readInformation:async()=>patch(information())});
        assert.equal(proof.proved,false);assert.equal(proof.proofs.content.status,'UNAVAILABLE');
        assert.equal(proof.failures.READ_PROOF_CONTENT_UNAVAILABLE,1);assert.equal(injected.calls.access.length,0);assert.equal(injected.calls.previews.length,0);
        assert.equal(JSON.stringify(proof).includes('senha: private'),false);assert.deepEqual(await counts(),before);
      }
    });
    await t.test('three mismatching customers exhaust the bound and dynamic errors are replaced by fixed codes',async()=>{
      const injected=provider({mismatch:['9002','9003','9004','9005']}),proof=await run(injected);
      assert.equal(proof.proved,false);assert.deepEqual(injected.calls.access,['9002','9003','9004']);
      assert.equal(proof.failures.RENEWAL_PROVIDER_EXPIRATION_MISMATCH,3);assert.equal(proof.failures.READ_PROOF_NO_VERIFIED_CUSTOMER,1);
      const unavailable=await run(provider({readError:Error('private username password and phone')}));
      assert.equal(unavailable.proved,false);assert.equal(unavailable.failures.READ_PROOF_UNAVAILABLE,1);
      assert.equal(JSON.stringify(unavailable).includes('private username'),false);assert.deepEqual(await counts(),before);
    });
    await t.test('a matching recent READY cache prioritizes a later account but cannot replace its new read or four quotes',async()=>{
      const customer='00000000-0000-4000-8000-000000000005';
      await db.query("UPDATE customer_access_sync SET status='STALE'");
      const markReady=()=>db.query(`INSERT INTO customer_access_sync(customer_id,subscription_id,list_id,username,owner,
        verified_whatsapp_e164,source_url,verified_at,attempted_at,status)
        SELECT c.id,s.id,s.bitpanel_list_id,c.bitpanel_reference,c.bitpanel_owner,c.whatsapp_e164,
          'https://bitpanel.vip/list/view/9005',$2::timestamptz,$2::timestamptz,'READY'
        FROM customers c JOIN LATERAL (SELECT id,bitpanel_list_id FROM subscriptions WHERE customer_id=c.id
          ORDER BY created_at DESC,id DESC LIMIT 1) s ON true WHERE c.id=$1
        ON CONFLICT(customer_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,list_id=EXCLUDED.list_id,
          username=EXCLUDED.username,owner=EXCLUDED.owner,verified_whatsapp_e164=EXCLUDED.verified_whatsapp_e164,
          source_url=EXCLUDED.source_url,verified_at=EXCLUDED.verified_at,attempted_at=EXCLUDED.attempted_at,status='READY'`,[customer,now().toISOString()]);
      const staleFirstProvider=()=>{
        const injected=provider(),read=injected.readAccess;
        injected.readAccess=async(runtime,binding)=>{
          if(binding.listId==='9002') {
            injected.calls.access.push(binding.listId);throw Object.assign(Error('synthetic unavailable account'),{code:'BITPANEL_READ_UNAVAILABLE'});
          }
          return read(runtime,binding);
        };
        return injected;
      };
      await markReady();
      const selected=staleFirstProvider(),proof=await run(selected);
      assert.equal(proof.proved,true);assert.deepEqual(selected.calls.access,['9005']);
      assert.deepEqual(selected.calls.previews.map(item=>item.duration_months),[1,3,6,12]);
      assert.equal(proof.proofs.customerAccess.attempted,1);assert.equal(proof.proofs.renewalPreview.validated,4);
      const otherSubscription=(await db.query('SELECT id FROM subscriptions WHERE customer_id=$1',[`00000000-0000-4000-8000-000000000004`])).rows[0].id;
      for(const [field,value] of [['status','STALE'],['subscription_id',otherSubscription],['list_id','9006'],['username','another.exact.user'],
        ['owner','Other reseller'],['verified_whatsapp_e164','5511999999598'],['source_url','https://outside.invalid/list/view/9005'],
        ['verified_at',new Date(now().getTime()+1).toISOString()],['verified_at',new Date(now().getTime()-24*60*60_000-1).toISOString()],
        ['verified_at',null],['verified_at','infinity'],['verified_at','-infinity']]) {
        await markReady();
        await db.query(`UPDATE customer_access_sync SET ${field}=$2 WHERE customer_id=$1`,[customer,value]);
        const notPreferred=staleFirstProvider(),failed=await run(notPreferred);
        assert.equal(failed.proved,false);assert.deepEqual(notPreferred.calls.access,['9002']);
        assert.equal(failed.failures.BITPANEL_READ_UNAVAILABLE,1);assert.equal(notPreferred.calls.previews.length,0);
      }
      await markReady();
      const staleLive=staleFirstProvider();
      staleLive.readAccess=async(_runtime,binding)=>{staleLive.calls.access.push(binding.listId);
        throw Object.assign(Error('synthetic changed provider binding'),{code:'BITPANEL_READ_LINK_UNVERIFIED'});};
      const noLiveProof=await run(staleLive);
      assert.equal(noLiveProof.proved,false);assert.equal(staleLive.calls.access[0],'9005');
      assert.equal(staleLive.calls.access.length,3);assert.equal(staleLive.calls.previews.length,0);
      await markReady();
      const incomplete=staleFirstProvider(),preview=incomplete.previewRenewal;
      incomplete.previewRenewal=async(runtime,renewal)=>{
        if(renewal.duration_months===12){incomplete.calls.previews.push(renewal);
          throw Object.assign(Error('synthetic annual form unavailable'),{code:'RENEWAL_PREVIEW_UNAVAILABLE'});}
        return preview(runtime,renewal);
      };
      const noFourQuotes=await run(incomplete);
      assert.equal(noFourQuotes.proved,false);assert.equal(noFourQuotes.failures.RENEWAL_PREVIEW_UNAVAILABLE,1);
      assert.deepEqual(incomplete.calls.access,['9005']);assert.deepEqual(incomplete.calls.previews.map(item=>item.duration_months),[1,3,6,12]);
      assert.equal(noFourQuotes.proofs.renewalPreview.validated,0);
      const output=JSON.stringify([proof,noLiveProof,noFourQuotes]);
      for(const secret of [customer,'synthetic.user','synthetic-password','55119999995','/list/view/'])assert.equal(output.includes(secret),false);
      assert.deepEqual(await counts(),before);
    });
    assert.equal(networkCalls,0);
  }finally{globalThis.fetch=fetchBefore;await pg.close();}
});
