import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {LiveBillingAutomation} from '../src/services/live-billing.js';
import {reconcileMercadoPagoPayment} from '../src/services/mercadopago-reconciliation.js';
import {claimRenewalExecution,expectedRenewalExpiration} from '../src/services/renewal-execution.js';
import {validateBitPanelRenewalQuote} from '../src/services/bitpanel-renewal-quote.js';

// All ledger rows and provider responses are synthetic. The production worker,
// browsers, payment transport and messaging transports are never imported.
test('explicit checkout to official reconciliation and guarded renewal completes once; unsafe money, quotes and historical approvals cannot actuate',async t=>{
  const pg=new PGlite({extensions:{pgcrypto}}),adapt=handle=>({query:async(sql,params)=>{
    const r=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await handle.exec(sql)).at(-1):await handle.query(sql,params);
    return{...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};
  }}),db={...adapt(pg),transaction:fn=>pg.transaction(tx=>fn(adapt(tx)))};
  let subjects=0,checkouts=0,actuations=0,networkCalls=0;
  const fetchBefore=globalThis.fetch;
  const durations={monthly:1,quarterly:3,semiannual:6,annual:12};
  const prices={monthly:3000,quarterly:8500,semiannual:15000,annual:27000};
  const expectedDates={monthly:'2099-02-28',quarterly:'2099-04-30',semiannual:'2099-07-31',annual:'2100-01-31'};
  const planIds=Object.fromEntries(Object.keys(durations).map(code=>[code,randomUUID()]));
  let policy;
  const setPolicy=value=>db.query("UPDATE system_settings SET value=$1::jsonb WHERE key='automatic_renewal_policy'",[JSON.stringify(value)]);
  const quote=(months,credits=months)=>`Renovar lista #${5000+subjects}.\nPlano: 30\nQuantidade de meses: ${months}\nTotal de conexões: 1\nTotal em créditos: ${credits}\nValor da unidade: R$ 30,00\nValor total: R$ ${months*30},00\nRENOVAR`;
  async function request(code){
    subjects++;
    const customer=randomUUID(),subscription=randomUUID(),providerId=String(990000000000+subjects),correlationId=randomUUID();
    await db.query(`INSERT INTO customers(id,name,whatsapp_e164,bitpanel_reference,bitpanel_owner,automation_eligible,status)
      VALUES($1,'Synthetic automatic flow',$2,$3,'Gate One Pro Server',true,'active')`,[customer,`551199998${String(subjects).padStart(4,'0')}`,`synthetic.user${subjects}`]);
    await db.query("INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id,status) VALUES($1,$2,$3,'2099-01-31',$4,'active')",[subscription,customer,planIds.monthly,String(5000+subjects)]);
    const billing=new LiveBillingAutomation({db,assertEnabled:async()=>{},createCheckout:async charge=>{
      checkouts++;
      return{id:`synthetic-${charge.id}`,checkoutUrl:`https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=synthetic-${charge.id}`,simulated:false};
    },recoverCheckout:async()=>{throw Error('UNEXPECTED_REAL_OR_RECOVERED_CHECKOUT');}});
    const checkout=await billing.requestPayment({customer_id:customer,plan_code:code,correlation_id:correlationId});
    const duplicate=await billing.requestPayment({customer_id:customer,plan_code:code,correlation_id:correlationId});
    assert.equal(duplicate.charge_id,checkout.charge_id);assert.equal(duplicate.checkout_url,checkout.checkout_url);
    const renewal=(await db.query('SELECT * FROM renewal_jobs WHERE charge_id=$1',[checkout.charge_id])).rows[0];
    assert.equal(renewal.core_status,'WAITING_PAYMENT');assert.equal(renewal.approved_at,null);
    const s={customer,subscription,providerId,checkout,renewalId:renewal.id,code};
    s.raw={id:providerId,status:'approved',live_mode:true,currency_id:'BRL',transaction_amount:prices[code]/100,
      external_reference:checkout.charge_id,collector_id:'synthetic-authorized-merchant',date_approved:new Date().toISOString()};
    return s;
  }
  const reconcile=(s,patch={})=>reconcileMercadoPagoPayment({db,config:{PAYMENT_MODE:'live'},paymentId:s.providerId,
    getPayment:async()=>({...s.raw,...patch}),getAccount:async()=>({id:'synthetic-authorized-merchant'})});
  const claim=s=>claimRenewalExecution(db,{renewalId:s.renewalId,correlationId:randomUUID(),requiresApproval:true,allowAutomatic:true,now:new Date()});
  const expiry=async s=>(await db.query('SELECT expires_on::text FROM subscriptions WHERE id=$1',[s.subscription])).rows[0].expires_on;
  async function syntheticActuator(claimed,quoted){
    assert.equal(claimed.claimed,true);assert.equal(claimed.automatic,true);
    const renewal={...claimed.renewal,automatic_renewal:true,expected_credit_cost:claimed.creditCost};
    validateBitPanelRenewalQuote(quoted,renewal,claimed.policy);
    const afterExpiry=expectedRenewalExpiration(renewal.current_expiry,renewal.duration_months);
    actuations++;
    return{beforeExpiry:renewal.current_expiry,afterExpiry,listId:renewal.bitpanel_list_id,simulated:false};
  }
  async function recordSyntheticCompletion(s,outcome){
    // Persist the same completion boundary used after the worker verifies its
    // provider result; this local fixture contains no provider mutation.
    await db.transaction(async client=>{
      const updated=await client.query(`UPDATE renewal_jobs SET status='completed',core_status='COMPLETED',before_expiry=$2,
        after_expiry=$3,completed_at=now(),updated_at=now() WHERE id=$1 AND core_status='PROCESSING' AND attempts=1 RETURNING id`,[s.renewalId,outcome.beforeExpiry,outcome.afterExpiry]);
      assert.equal(updated.rowCount,1);
      await client.query("UPDATE subscriptions SET plan_id=$2,expires_on=$3,updated_at=now() WHERE id=$1",[s.subscription,planIds[s.code],outcome.afterExpiry]);
    });
  }
  try{
    await migrateDatabase(db);
    globalThis.fetch=async()=>{networkCalls++;throw Error('NETWORK_FORBIDDEN_IN_AUTOMATIC_RENEWAL_TEST');};
    for(const code of Object.keys(durations))await db.query('INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,$2,$2,$3,$4)',[planIds[code],code,durations[code],prices[code]]);
    const activatedAt=new Date(Date.now()-2_000).toISOString(),validatedAt=new Date(Date.now()-3_000).toISOString();
    policy={enabled:true,activatedAt,validatedAt,validatedSource:'https://bitpanel.vip/list',provider:'mercadopago',operation:'renew',
      planLabel:'30',unitPriceCents:3000,maxConnections:1,maxCreditsPerRenewal:12,
      plans:Object.fromEntries(Object.keys(durations).map(code=>[code,{durationMonths:durations[code],priceCents:prices[code],creditCost:durations[code]}]))};
    for(const [key,value] of Object.entries({automatic_renewal_policy:policy,global_pause:false,payment_mode:'live',bitpanel_mode:'live',renewal_requires_approval:true}))
      await db.query('INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[key,JSON.stringify(value)]);
    for(const code of Object.keys(durations))await t.test(`${code}: explicit plan, provider-confirmed payment, quote validation and verified expiry complete exactly once`,async()=>{
      const beforeCheckouts=checkouts,beforeActuations=actuations,s=await request(code);
      assert.equal(checkouts,beforeCheckouts+1);
      // A pending or mismatched payment cannot claim or increment attempts.
      await assert.rejects(claim(s),{code:'VERIFIED_PAYMENT_REQUIRED'});assert.equal(actuations,beforeActuations);
      assert.equal((await db.query('SELECT attempts,core_status FROM renewal_jobs WHERE id=$1',[s.renewalId])).rows[0].attempts,0);
      assert.equal((await reconcile(s)).confirmed,true);
      const payment=(await db.query('SELECT * FROM payments WHERE id=$1',[s.checkout.payment_id])).rows[0];
      assert.equal(payment.status,'CONFIRMED');assert.equal(payment.reconciliation_status,'MATCHED');assert.ok(payment.provider_observed_at);
      assert.equal(payment.provider_payload.date_approved,s.raw.date_approved);assert.ok(new Date(payment.confirmed_at)>=new Date(policy.activatedAt));
      const claimed=await claim(s);assert.equal(claimed.automatic,true);assert.equal(claimed.creditCost,durations[code]);
      assert.equal(claimed.policy.unitPriceCents,3000);assert.equal(claimed.renewal.approved_at,null);
      await assert.rejects(claim(s),{code:'RENEWAL_RESULT_REQUIRES_REVIEW'});
      const outcome=await syntheticActuator(claimed,quote(durations[code]));assert.equal(outcome.afterExpiry,expectedDates[code]);
      await recordSyntheticCompletion(s,outcome);assert.equal(await expiry(s),expectedDates[code]);
      assert.equal((await reconcile(s)).duplicate,true);assert.deepEqual(await claim(s),{claimed:false,duplicate:true});
      assert.equal(actuations,beforeActuations+1);
      const completed=(await db.query('SELECT * FROM renewal_jobs WHERE id=$1',[s.renewalId])).rows[0];
      assert.equal(completed.core_status,'COMPLETED');assert.equal(completed.attempts,1);assert.equal(completed.approved_at,null);
      assert.equal((await db.query("SELECT count(*)::int n FROM gate_event_outbox WHERE event_type='payment.confirmed' AND subject->>'id'=$1",[payment.id])).rows[0].n,1);
    });
    await t.test('wrong provider amount leaves payment pending and blocks claim before any actuator',async()=>{
      const before=actuations,s=await request('monthly');
      await assert.rejects(reconcile(s,{transaction_amount:29.99}),{code:'PAYMENT_AMOUNT_MISMATCH'});
      await assert.rejects(claim(s),{code:'VERIFIED_PAYMENT_REQUIRED'});
      assert.equal(actuations,before);assert.equal(await expiry(s),'2099-01-31');
      assert.equal((await db.query('SELECT status FROM payments WHERE id=$1',[s.checkout.payment_id])).rows[0].status,'PENDING');
      assert.equal((await db.query('SELECT attempts FROM renewal_jobs WHERE id=$1',[s.renewalId])).rows[0].attempts,0);
    });
    await t.test('changed credit quote stops before the actuator and enters review; a replay cannot retry it',async()=>{
      const before=actuations,s=await request('monthly');await reconcile(s);const claimed=await claim(s);
      await assert.rejects(syntheticActuator(claimed,quote(1,2)),/RENEWAL_PROVIDER_QUOTE_MISMATCH/);
      assert.equal(actuations,before);assert.equal(await expiry(s),'2099-01-31');
      await db.query("UPDATE renewal_jobs SET status='failed',core_status='HUMAN_ACTION_REQUIRED',failure_reason='RENEWAL_PROVIDER_QUOTE_MISMATCH' WHERE id=$1",[s.renewalId]);
      await assert.rejects(claim(s),{code:'RENEWAL_RESULT_REQUIRES_REVIEW'});
    });
    await t.test('an official approval before activation cannot authorize even when first observed and confirmed afterwards',async()=>{
      const before=actuations,s=await request('monthly');
      await reconcile(s,{date_approved:new Date(new Date(policy.activatedAt).getTime()-60_000).toISOString()});
      const payment=(await db.query('SELECT * FROM payments WHERE id=$1',[s.checkout.payment_id])).rows[0];
      assert.equal(payment.reconciliation_status,'MATCHED');assert.ok(new Date(payment.confirmed_at)>=new Date(policy.activatedAt));
      await assert.rejects(claim(s),{code:'RENEWAL_APPROVAL_REQUIRED'});
      assert.equal(actuations,before);assert.equal(await expiry(s),'2099-01-31');
    });
    await t.test('a policy credit amount beyond its approved ceiling cannot claim the renewal',async()=>{
      const before=actuations,s=await request('monthly');await reconcile(s);
      await setPolicy({...policy,plans:{...policy.plans,monthly:{...policy.plans.monthly,creditCost:13}}});
      await assert.rejects(claim(s),{code:'RENEWAL_APPROVAL_REQUIRED'});await setPolicy(policy);
      assert.equal(actuations,before);assert.equal(await expiry(s),'2099-01-31');
    });
    assert.equal(actuations,4);assert.equal(networkCalls,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM message_logs')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM notification_requests')).rows[0].n,0);
    assert.equal((await db.query("SELECT value FROM system_settings WHERE key='renewal_requires_approval'")).rows[0].value,true);
  }finally{globalThis.fetch=fetchBefore;await pg.close();}
});
