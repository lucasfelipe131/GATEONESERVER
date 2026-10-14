import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {markPaymentApproved} from '../src/services/billing.js';
import {reconcileMercadoPagoPayment} from '../src/services/mercadopago-reconciliation.js';

test('only an authenticated Mercado Pago reconciliation marks both inserted and existing payments as MATCHED',async t=>{
  const pg=new PGlite({extensions:{pgcrypto}}),adapt=handle=>({query:async(sql,params)=>{
    const r=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await handle.exec(sql)).at(-1):await handle.query(sql,params);
    return{...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};
  }}),db={...adapt(pg),transaction:fn=>pg.transaction(tx=>fn(adapt(tx)))};
  let sequence=0;
  const plan=randomUUID();
  async function subject({provider='mercadopago',pending=false,review=false}={}){
    sequence++;
    const customer=randomUUID(),subscription=randomUUID(),charge=randomUUID(),payment=randomUUID();
    await db.query("INSERT INTO customers(id,name,whatsapp_e164,status) VALUES($1,'Synthetic reconciliation',$2,'active')",[customer,`551199999${String(sequence).padStart(4,'0')}`]);
    await db.query("INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id) VALUES($1,$2,$3,'2099-01-01','12345')",[subscription,customer,plan]);
    await db.query(`INSERT INTO charges(id,subscription_id,plan_id,stage,status,amount_cents,due_on,idempotency_key,message_text)
      VALUES($1,$2,$3,'manual','sent',3000,'2099-01-01',$4,'Synthetic charge')`,[charge,subscription,plan,`synthetic:${charge}`]);
    if(pending)await db.query(`INSERT INTO payments(id,customer_id,subscription_id,charge_id,provider,amount_cents,status,idempotency_key,correlation_id,reconciliation_status,review_reason)
      VALUES($1,$2,$3,$4,$5,3000,'PENDING',$6,$7,$8,$9)`,[payment,customer,subscription,charge,provider,`pending:${charge}`,randomUUID(),review?'REQUIRES_REVIEW':null,review?'UNTRUSTED_CONFIRMATION_SOURCE':null]);
    return{customer,subscription,charge,payment};
  }
  const raw=(s,id)=>({id,status:'approved',live_mode:true,currency_id:'BRL',transaction_amount:30,external_reference:s.charge,collector_id:'synthetic-merchant',date_approved:new Date().toISOString()});
  const reconcile=(s,id,patch={})=>reconcileMercadoPagoPayment({db,config:{PAYMENT_MODE:'live'},paymentId:id,
    getPayment:async()=>({...raw(s,id),...patch}),getAccount:async()=>({id:'synthetic-merchant'})});
  const rows=s=>db.query('SELECT * FROM payments WHERE customer_id=$1',[s.customer]);
  try{
    await migrateDatabase(db);await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Mensal',1,3000)",[plan]);
    await t.test('a reconciled payment with no pending ledger inserts MATCHED and observation timestamp once',async()=>{
      const s=await subject(),id='123456789001',before=new Date();
      assert.equal((await reconcile(s,id)).confirmed,true);
      const payment=(await rows(s)).rows[0];
      assert.equal(payment.reconciliation_status,'MATCHED');assert.ok(payment.provider_observed_at);assert.ok(new Date(payment.provider_observed_at)>=before);
      assert.equal(payment.provider_payload.live_mode,true);assert.equal(payment.provider_payload.source,'PROVIDER_RECONCILIATION');
      const observed=payment.provider_observed_at;assert.equal((await reconcile(s,id)).duplicate,true);
      assert.equal((await rows(s)).rows.length,1);assert.deepEqual((await rows(s)).rows[0].provider_observed_at,observed);
      assert.equal((await db.query("SELECT count(*)::int n FROM gate_event_outbox WHERE event_type='payment.confirmed' AND subject->>'id'=$1",[payment.id])).rows[0].n,1);
      assert.equal((await db.query('SELECT count(*)::int n FROM renewal_jobs WHERE payment_id=$1',[payment.id])).rows[0].n,1);
      assert.equal((await db.query('SELECT expires_on::text FROM subscriptions WHERE id=$1',[s.subscription])).rows[0].expires_on,'2099-01-01');
    });
    await t.test('a pending Mercado Pago ledger is updated only after official matching validation',async()=>{
      const s=await subject({pending:true,review:true});
      assert.equal((await reconcile(s,'123456789002')).confirmed,true);
      const payment=(await rows(s)).rows[0];assert.equal(payment.id,s.payment);assert.equal(payment.reconciliation_status,'MATCHED');
      assert.ok(payment.provider_observed_at);assert.equal(payment.review_reason,null);assert.equal(payment.external_payment_id,'123456789002');
      assert.ok(payment.provider_payload.date_approved);assert.equal(payment.provider_payload.live_mode,true);assert.equal(payment.provider_payload.source,'PROVIDER_RECONCILIATION');
    });
    await t.test('manual, fake and direct unverified confirmations do not manufacture provider provenance',async()=>{
      for(const {provider,pending,liveMode,id,context} of [
        {provider:'manual',pending:false,liveMode:true,id:'MANUAL-123'},
        {provider:'fake',pending:false,liveMode:true,id:'123456789003',context:true},
        {provider:'fake',pending:true,liveMode:true,id:'123456789004',context:true},
        {provider:'mercadopago',pending:true,liveMode:true,id:'123456789005'},
        {provider:'mercadopago',pending:false,liveMode:false,id:'123456789006',context:true}
      ]){
        const s=await subject({provider,pending,review:pending});
        await markPaymentApproved(db,s.charge,{id,provider,status:'approved',live_mode:liveMode,currency_id:'BRL'},
          context?{source:'PROVIDER_RECONCILIATION',providerVerified:true,observedAt:new Date().toISOString()}:undefined);
        const payment=(await rows(s)).rows[0];assert.notEqual(payment.reconciliation_status,'MATCHED');assert.equal(payment.provider_observed_at,null);
        if(pending){assert.equal(payment.reconciliation_status,'REQUIRES_REVIEW');assert.equal(payment.review_reason,'UNTRUSTED_CONFIRMATION_SOURCE');}
        else{assert.equal(payment.reconciliation_status,null);assert.equal(payment.provider_payload.source,undefined);}
      }
    });
    await t.test('invalid official subject, amount, currency, collector and test-mode responses cannot create payment provenance',async()=>{
      const s=await subject();
      for(const patch of [{transaction_amount:29.99},{currency_id:'USD'},{collector_id:'other-merchant'},{live_mode:false},{external_reference:randomUUID()}])
        await assert.rejects(reconcile(s,'123456789007',patch));
      assert.equal((await rows(s)).rows.length,0);
      assert.equal((await db.query('SELECT status FROM charges WHERE id=$1',[s.charge])).rows[0].status,'sent');
      assert.equal((await db.query('SELECT count(*)::int n FROM renewal_jobs WHERE charge_id=$1',[s.charge])).rows[0].n,0);
    });
  }finally{await pg.close();}
});
