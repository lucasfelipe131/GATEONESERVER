import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {getSetting,setSetting} from '../src/db.js';
import {automaticRenewalDecision} from '../src/services/automatic-renewal-policy.js';
import {runCustomerHubActivation,customerHubActivationFailureReport} from '../scripts/customer-hub-activate.js';
import {assertCustomerHubReadProofReady,runCustomerHubReadProof} from '../scripts/customer-hub-read-proof.js';

test('activation requires complete current-version evidence before enabling the provider',async t=>{
  const pg=new PGlite({extensions:{pgcrypto}});
  let hook=null;
  const adapt=handle=>({query:async(sql,params)=>{
    const raw=async(text,values)=>{
      const result=!values && /;\s*\S/.test(text.trim().replace(/;$/,'')) ? (await handle.exec(text)).at(-1) : await handle.query(text,values);
      return {...result,rowCount:result.rowCount??result.affectedRows??result.rows.length};
    };
    if(hook) await hook(sql,params,raw);
    return raw(sql,params);
  }});
  const db={...adapt(pg),transaction:fn=>pg.transaction(tx=>fn(adapt(tx)))};
  const expectedSha='b'.repeat(40),environment={RAILWAY_PROJECT_ID:'a0f107fe-acaf-459f-a640-38ef6010d1e5',
    RAILWAY_ENVIRONMENT_ID:'697f58fb-5084-4cb3-bd9a-ecdbc921b7bc',RAILWAY_GIT_COMMIT_SHA:expectedSha};
  const config={COOKIE_SECRET:'synthetic-activation-proof-secret',BITPANEL_BASE_URL:'https://bitpanel.vip',
    BITPANEL_MODE:'disabled',BITPANEL_STORAGE_STATE:JSON.stringify({cookies:[],origins:[]}),TIMEZONE:'America/Sao_Paulo'};
  const customer=randomUUID(),subscription=randomUUID(),plan=randomUUID();
  let instant=new Date('2026-10-13T12:00:00.000Z'),runtime={...config},env={...environment};
  const now=()=>new Date(instant);
  const information=()=>({source:'https://bitpanel.vip/notices',status:'READY',verifiedAt:now().toISOString(),
    posts:[{source:'bitpanel',title:'Aviso de demonstração',content:'Informação sintética para clientes.',category:'notices',
      url:'https://bitpanel.vip/notices',publishedAt:'2026-10-08T03:13:00.000Z',verifiedAt:now().toISOString()},
    {source:'bitpanel',title:'Novidade de demonstração',content:'Novidade sintética de demonstração.',category:'news',
      url:'https://bitpanel.vip/news',publishedAt:'2026-10-05T01:39:00.000Z',verifiedAt:now().toISOString()}],
    dnsVerified:true,dns:[{name:'DNS de demonstração',value:'http://auth.urlcld.com',status:'READY',
      sourceUrl:'https://bitpanel.vip/notices',verifiedAt:now().toISOString()}]});
  const provider=({failingMonths,changeAfterPreview}={})=>{
    const calls=[];
    return {calls,testConnection:async()=>({ok:true}),readInformation:async()=>information(),
      readAccess:async(_runtime,binding)=>({...binding,password:'synthetic-secret-password',
        sourceUrl:`https://bitpanel.vip/list/view/${binding.listId}`}),
      previewRenewal:async(_runtime,renewal)=>{
        calls.push(renewal.duration_months);
        assert.equal(await getSetting(db,'bitpanel_mode',null),'disabled');
        assert.equal((await getSetting(db,'automatic_renewal_policy',null)).enabled,false);
        if(changeAfterPreview) await changeAfterPreview(renewal);
        if(failingMonths===renewal.duration_months) return {prepared:true,submitted:true};
        const months=renewal.duration_months;
        return {prepared:true,submitted:false,balance:{status:'verified',availableCredits:90,sufficient:true},sourceUrl:'https://bitpanel.vip/list/view/7001',
          quote:{listId:'7001',planLabel:'30',months,connections:1,credits:months,unitPriceCents:3000,totalPriceCents:3000*months}};
      }};
  };
  const reset=async()=>{
    hook=null;instant=new Date('2026-10-13T12:00:00.000Z');runtime={...config};env={...environment};
    await db.query('DELETE FROM customer_access_sync');
    await db.query('UPDATE customers SET access_password_encrypted=NULL WHERE id=$1',[customer]);
    for(const [key,value] of Object.entries({payment_mode:'live',global_pause:false,bitpanel_mode:'disabled',
      renewal_requires_approval:true,bitpanel_read_sync_enabled:false,automatic_renewal_policy:{enabled:false},
      customer_help_catalog:{suggestedApps:[{name:'Existing app evidence',verifiedAt:'2026-10-01T12:00:00.000Z'}],
        telegram:{channelUrl:'https://t.me/+ExistingPrivateInviteFixture',verifiedAt:'2026-10-01T12:00:00.000Z'}}}))
      await setSetting(db,key,value);
    await db.query("UPDATE subscriptions SET expires_on='2099-01-31' WHERE id=$1",[subscription]);
    await db.query("UPDATE plans SET price_cents=3000,duration_months=1 WHERE code='monthly'");
  };
  const run=(injected,patch={})=>runCustomerHubActivation({db,config,expectedSha,env,now,
    runtimeConfig:async()=>runtime,proofOptions:injected,activate:true,...patch});
  const assertDisabled=async()=>{
    assert.equal(await getSetting(db,'bitpanel_mode',null),'disabled');
    assert.equal((await getSetting(db,'automatic_renewal_policy',null)).enabled,false);
    assert.equal(await getSetting(db,'bitpanel_read_sync_enabled',null),false);
  };
  const fetchBefore=globalThis.fetch;let networkCalls=0;
  try {
    await migrateDatabase(db);
    globalThis.fetch=async()=>{networkCalls++;throw Error('REAL_NETWORK_FORBIDDEN');};
    for(const [code,months,price] of [['monthly',1,3000],['quarterly',3,8500],['semiannual',6,15000],['annual',12,27000]])
      await db.query('INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,$2,$2,$3,$4)',[code==='monthly'?plan:randomUUID(),code,months,price]);
    await db.query(`INSERT INTO customers(id,name,whatsapp_e164,bitpanel_reference,bitpanel_owner,automation_eligible)
      VALUES($1,'Synthetic proof customer','5511999999777','synthetic.own.user','Gate One Pro Server',true)`,[customer]);
    await db.query(`INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id)
      VALUES($1,$2,$3,'2099-01-31','7001')`,[subscription,customer,plan]);

    await t.test('validation alone proves and caches content/access but leaves automation disabled',async()=>{
      await reset();const injected=provider(),report=await run(injected,{activate:false});
      assert.equal(report.validated,true);assert.equal(report.activated,false);await assertDisabled();
      assert.deepEqual(injected.calls,[1,3,6,12]);assert.equal(report.proof.sha,expectedSha);
      assert.equal(report.proof.proofs.content.cacheStatus,'READY');
      const catalog=await getSetting(db,'customer_help_catalog',{});
      assert.equal(catalog.bitpanelSync.status,'READY');assert.equal(catalog.posts.length,2);assert.equal(catalog.dns.length,1);
      assert.equal(catalog.suggestedApps[0].verifiedAt,'2026-10-01T12:00:00.000Z');
      const output=JSON.stringify(report);
      for(const secret of ['synthetic.own.user','synthetic-secret-password','5511999999777',customer,subscription,'/list/view/7001'])
        assert.equal(output.includes(secret),false);
    });
    await t.test('activation happens after four previews and cache checks, then reports successful postchecks',async()=>{
      await reset();const injected=provider();
      let liveWrites=0;
      hook=async(sql,params)=>{
        if(sql.includes('INSERT INTO system_settings') && params?.[0]==='bitpanel_mode' && params[1]==='"live"') {
          assert.deepEqual(injected.calls,[1,3,6,12]);liveWrites++;
        }
      };
      const report=await run(injected);hook=null;
      assert.equal(liveWrites,1);assert.equal(report.activated,true);assert.equal(report.validated,true);
      assert.equal(await getSetting(db,'bitpanel_mode',null),'live');
      const policy=await getSetting(db,'automatic_renewal_policy',null);
      assert.equal(policy.validatedSha,expectedSha);assert.equal(policy.activatedAt,now().toISOString());
      assert.equal(policy.validatedAt,report.proof.validatedAt);assert.equal(Object.keys(policy.plans).length,4);
      assert.equal(await getSetting(db,'renewal_requires_approval',null),true);
      assert.equal(await getSetting(db,'bitpanel_read_sync_enabled',null),true);
    });
    await t.test('every missing or submitted quote blocks activation, including annual after three successes',async()=>{
      for(const months of [1,3,6,12]) {
        await reset();const injected=provider({failingMonths:months}),report=await run(injected);
        assert.equal(report.activated,false);assert.equal(report.validated,false);await assertDisabled();
        assert.equal(report.proof.failures.RENEWAL_PROVIDER_QUOTE_MISMATCH,1);
        assert.equal(report.proof.proofs.content.cacheStatus,undefined);
        assert.equal(injected.calls.at(-1),months);
      }
    });
    await t.test('unusable public content and stale DNS stop before any account lookup or preview',async()=>{
      for(const patch of [info=>({...info,status:'STALE'}),info=>({...info,dnsVerified:false}),info=>({...info,posts:info.posts.map(post=>({...post,content:'senha: private'}))}),
        info=>({...info,dns:info.dns.map(dns=>({...dns,verifiedAt:'2026-10-11T12:00:00.000Z'}))})]) {
        await reset();const injected=provider(),report=await run({...injected,readInformation:async()=>patch(information())});
        assert.equal(report.activated,false);assert.equal(report.proof.failures.READ_PROOF_CONTENT_UNAVAILABLE,1);
        assert.deepEqual(injected.calls,[]);await assertDisabled();
      }
    });
    await t.test('wrong SHA, changed SHA during previews and changed protected runtime cannot enable automation',async()=>{
      await reset();const wrong=provider();env.RAILWAY_GIT_COMMIT_SHA='c'.repeat(40);
      await assert.rejects(run(wrong),{code:'READ_PROOF_VERSION_MISMATCH'});assert.deepEqual(wrong.calls,[]);await assertDisabled();
      await reset();const changed=provider({changeAfterPreview:async renewal=>{if(renewal.duration_months===12)env.RAILWAY_GIT_COMMIT_SHA='c'.repeat(40);}});
      const report=await run(changed);assert.equal(report.proof.failures.READ_PROOF_VERSION_MISMATCH,1);await assertDisabled();
      await reset();const session=provider({changeAfterPreview:async renewal=>{if(renewal.duration_months===12)runtime={...runtime,BITPANEL_STORAGE_STATE:'changed-protected-session'};}});
      await assert.rejects(run(session),{code:'READ_PROOF_RUNTIME_CHANGED'});await assertDisabled();
    });
    await t.test('a pause, policy edit or price change during proof is caught before the final mode switch',async()=>{
      for(const [change,errorCode] of [
        [()=>setSetting(db,'global_pause',true),'AUTOMATIONS_MUST_BE_UNPAUSED'],
        [()=>setSetting(db,'automatic_renewal_policy',{enabled:false,administratorRevision:2}),'ACTIVATION_SETTINGS_CHANGED'],
        [()=>db.query("UPDATE plans SET price_cents=3001 WHERE code='monthly'"),'READ_PROOF_PLANS_MISMATCH']
      ]) {
        await reset();const injected=provider({changeAfterPreview:async renewal=>{if(renewal.duration_months===12)await change();}});
        await assert.rejects(run(injected),error=>{
          assert.equal(customerHubActivationFailureReport(error).errorCode,errorCode);return true;
        });
        assert.equal(await getSetting(db,'bitpanel_mode',null),'disabled');
        assert.equal((await getSetting(db,'automatic_renewal_policy',null)).enabled,false);
        assert.equal(await getSetting(db,'bitpanel_read_sync_enabled',null),false);
      }
    });
    await t.test('serialized receipts cannot be replayed and verified evidence expires after one minute',async()=>{
      await reset();const injected=provider(),proof=await runCustomerHubReadProof({db,config,expectedSha,env,now,
        runtimeConfig:async()=>runtime,cacheContent:true,...injected});
      assert.equal(proof.proved,true);
      const check=patch=>assertCustomerHubReadProofReady({db,config,expectedSha,env,now,runtimeConfig:async()=>runtime,proof,...patch});
      await assert.rejects(check({proof:JSON.parse(JSON.stringify(proof))}),{code:'READ_PROOF_RECEIPT_REQUIRED'});
      instant=new Date(instant.getTime()+60_001);await assert.rejects(check(),{code:'READ_PROOF_STALE'});await assertDisabled();
    });
    await t.test('unknown balance permits read-only quotes but blocks activation; known nine credits remains a valid quote',async()=>{
      const balanceProvider=balance=>{
        const injected=provider(),preview=injected.previewRenewal;
        injected.previewRenewal=async(...args)=>({...await preview(...args),balance:balance(args[1].duration_months)});
        return injected;
      };
      await reset();const unknown=()=>({status:'unverified',availableCredits:null,sufficient:null});
      const report=await run(balanceProvider(unknown),{activate:false});assert.equal(report.validated,true);
      assert.equal(report.proof.proofs.renewalPreview.validated,4);assert.equal(report.proof.proofs.renewalPreview.balanceVerified,0);await assertDisabled();
      await reset();await assert.rejects(run(balanceProvider(unknown)),error=>{
        const failed=customerHubActivationFailureReport(error);
        assert.equal(failed.errorCode,'READ_PROOF_BALANCE_UNVERIFIED');assert.equal(failed.activated,false);
        assert.equal(failed.proof.proofs.renewalPreview.validated,4);assert.equal(failed.proof.proofs.renewalPreview.balanceVerified,0);
        return true;
      });await assertDisabled();
      await reset();const known=await run(balanceProvider(months=>({status:'verified',availableCredits:9,sufficient:months<=9})),{activate:false});
      assert.equal(known.validated,true);assert.equal(known.proof.proofs.renewalPreview.balanceVerified,4);await assertDisabled();
    });
    await t.test('cache or binding changes in the final transaction roll back every activation write',async()=>{
      for(const mutation of [
        raw=>raw("UPDATE customer_access_sync SET status='STALE' WHERE customer_id=$1",[customer]),
        raw=>raw("UPDATE customers SET access_password_encrypted='corrupted-secret-cache' WHERE id=$1",[customer]),
        raw=>raw("UPDATE subscriptions SET expires_on='2099-02-01' WHERE id=$1",[subscription]),
        raw=>raw("UPDATE system_settings SET value=jsonb_set(value,'{bitpanelSync,status}','\"STALE\"') WHERE key='customer_help_catalog'")
      ]) {
        await reset();let changed=false;
        hook=async(sql,_params,raw)=>{if(!changed && sql==='SELECT provider FROM integration_credentials FOR SHARE'){changed=true;await mutation(raw);}};
        await assert.rejects(run(provider()),error=>['BITPANEL_READ_LINK_UNVERIFIED','READ_PROOF_CONTENT_CACHE_UNAVAILABLE'].includes(error.code));
        hook=null;assert.equal(changed,true);await assertDisabled();
      }
    });
    await t.test('a failed postcheck rolls back the mode, policy and read-sync switch',async()=>{
      await reset();let written=false;
      hook=async(sql,params,raw)=>{
        if(sql.includes('INSERT INTO system_settings') && params?.[0]==='bitpanel_mode' && params[1]==='"live"')written=true;
        if(written && sql==='SELECT value FROM system_settings WHERE key = $1' && params[0]==='bitpanel_mode') {
          await raw("UPDATE system_settings SET value='\"disabled\"'::jsonb WHERE key='bitpanel_mode'");written=false;
        }
      };
      await assert.rejects(run(provider()),error=>{
        const failed=customerHubActivationFailureReport(error);
        assert.equal(failed.errorCode,'ACTIVATION_POSTCHECK_FAILED');assert.equal(failed.activated,false);
        assert.equal(failed.proof.proved,true);
        return true;
      });hook=null;await assertDisabled();
    });
    await t.test('re-enabling a previously enabled policy creates a new cutoff and rejects payments from the pause',async()=>{
      await reset();await setSetting(db,'automatic_renewal_policy',{enabled:true,activatedAt:'2026-10-01T12:00:00.000Z'});
      const injected=provider();injected.previewRenewal=async(_runtime,renewal)=>{
        injected.calls.push(renewal.duration_months);assert.equal(await getSetting(db,'bitpanel_mode',null),'disabled');
        const months=renewal.duration_months;
        return{prepared:true,submitted:false,balance:{status:'verified',availableCredits:90,sufficient:true},sourceUrl:'https://bitpanel.vip/list/view/7001',
          quote:{listId:'7001',planLabel:'30',months,connections:1,credits:months,unitPriceCents:3000,totalPriceCents:3000*months}};
      };
      const report=await run(injected),policy=await getSetting(db,'automatic_renewal_policy',null);
      assert.equal(report.activated,true);assert.equal(policy.activatedAt,'2026-10-13T12:00:00.000Z');
      const paymentId=randomUUID(),chargeId=randomUUID();
      const renewal={id:randomUUID(),customer_id:customer,subscription_id:subscription,payment_id:paymentId,charge_id:chargeId,
        bitpanel_list_id:'7001',bitpanel_reference:'synthetic.own.user',bitpanel_owner:'Gate One Pro Server',automation_eligible:true,
        attempts:0,status:'awaiting_approval',core_status:'READY',charge_status:'paid',plan_code:'monthly',duration_months:1,
        requested_extension_months:1,charge_amount_cents:3000,plan_price_cents:3000};
      const payment={id:paymentId,customer_id:customer,subscription_id:subscription,charge_id:chargeId,provider:'mercadopago',
        status:'CONFIRMED',currency:'BRL',reconciliation_status:'MATCHED',external_payment_id:'7007001',amount_cents:3000,
        confirmed_at:'2026-10-12T12:00:00.000Z',provider_payload:{date_approved:'2026-10-12T11:59:00.000Z'}};
      assert.equal(automaticRenewalDecision({policy,renewal,payment,customer:{id:customer,subscription_id:subscription,
        bitpanel_list_id:'7001',bitpanel_reference:'synthetic.own.user',bitpanel_owner:'Gate One Pro Server',automation_eligible:true},now:now()}).code,
        'AUTO_RENEWAL_PAYMENT_BEFORE_ACTIVATION');
    });
    const counts=(await db.query(`SELECT (SELECT count(*) FROM charges)::int charges,(SELECT count(*) FROM payments)::int payments,
      (SELECT count(*) FROM renewal_jobs)::int renewals,(SELECT count(*) FROM message_logs)::int messages,
      (SELECT count(*) FROM gate_event_outbox)::int outbox,(SELECT count(*) FROM notification_requests)::int notices`)).rows[0];
    assert.deepEqual(counts,{charges:0,payments:0,renewals:0,messages:0,outbox:0,notices:0});assert.equal(networkCalls,0);
  }finally{hook=null;globalThis.fetch=fetchBefore;await pg.close();}
});
