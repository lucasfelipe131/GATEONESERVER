import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {setSetting} from '../src/db.js';
import {assertRenewalBindingUnique,claimRenewalExecution,recoverPolicyRenewals,verifyRenewalExecutionBinding} from '../src/services/renewal-execution.js';

const NOW=new Date('2026-10-12T12:00:00Z');
const OWNER='Gate One Pro Server';
const policy={enabled:true,activatedAt:'2026-10-12T10:00:00Z',validatedAt:'2026-10-12T09:00:00Z',
  provider:'mercadopago',operation:'renew',planLabel:'30',maxConnections:1,unitPriceCents:3000,maxCreditsPerRenewal:12,
  plans:{monthly:{durationMonths:1,priceCents:3000,creditCost:1}}};

async function fixture(){
  const pg=new PGlite({extensions:{pgcrypto}}),adapter=handle=>({query:async(sql,params)=>{
    const result=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await handle.exec(sql)).at(-1):await handle.query(sql,params);
    return{...result,rowCount:result.rowCount??result.affectedRows??result.rows.length};
  }}),db={...adapter(pg),transaction:fn=>pg.transaction(client=>fn(adapter(client)))};
  await migrateDatabase(db);const plan=randomUUID();let serial=0;
  await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Synthetic monthly',1,3000)",[plan]);
  for(const [key,value] of Object.entries({automatic_renewal_policy:policy,global_pause:false,payment_mode:'live',bitpanel_mode:'live',renewal_requires_approval:true}))
    await setSetting(db,key,value);
  async function subject({username='synthetic.access',listId='321',status='active'}={}){
    serial++;const customerId=randomUUID(),subscriptionId=randomUUID(),charge=randomUUID(),payment=randomUUID(),renewalId=randomUUID(),correlationId=randomUUID();
    await db.query(`INSERT INTO customers(id,name,whatsapp_e164,bitpanel_reference,bitpanel_owner,automation_eligible,status)
      VALUES($1,'Synthetic binding',$2,$3,$4,true,$5)`,[customerId,`5511999999${String(serial).padStart(3,'0')}`,username,OWNER,status]);
    await db.query(`INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id,created_at)
      VALUES($1,$2,$3,'2026-11-01',$4,now()-interval '1 day')`,[subscriptionId,customerId,plan,listId]);
    await db.query(`INSERT INTO charges(id,subscription_id,plan_id,stage,status,amount_cents,due_on,idempotency_key,message_text)
      VALUES($1,$2,$3,'manual','paid',3000,'2026-11-01',$4,'Synthetic binding charge')`,[charge,subscriptionId,plan,randomUUID()]);
    await db.query(`INSERT INTO payments(id,customer_id,subscription_id,charge_id,provider,external_payment_id,amount_cents,status,
      reconciliation_status,currency,confirmed_at,idempotency_key,correlation_id,provider_payload)
      VALUES($1,$2,$3,$4,'mercadopago',$5,3000,'CONFIRMED','MATCHED','BRL','2026-10-12T11:00:00Z',$6,$7,
      '{"date_approved":"2026-10-12T11:00:00Z","live_mode":true}'::jsonb)`,[payment,customerId,subscriptionId,charge,String(88000000+serial),randomUUID(),correlationId]);
    await db.query(`INSERT INTO renewal_jobs(id,charge_id,payment_id,status,core_status,requested_extension_months,previous_expiration)
      VALUES($1,$2,$3,'awaiting_approval','READY',1,'2026-11-01')`,[renewalId,charge,payment]);
    return{customerId,subscriptionId,listId,username,owner:OWNER,renewalId,correlationId,currentExpiry:'2026-11-01',charge,payment};
  }
  const one=await subject();
  const claim=subject=>claimRenewalExecution(db,{renewalId:subject.renewalId,correlationId:subject.correlationId,now:NOW});
  const verify=(subject,options={})=>verifyRenewalExecutionBinding(db,subject,{now:NOW,...options});
  const snapshot=async()=>({jobs:(await db.query('SELECT id,status,core_status,attempts,approved_at,completed_at FROM renewal_jobs ORDER BY id')).rows,
    payments:(await db.query('SELECT id,status,amount_cents FROM payments ORDER BY id')).rows,
    charges:(await db.query('SELECT id,status,amount_cents FROM charges ORDER BY id')).rows,
    expiry:(await db.query('SELECT id,expires_on::text FROM subscriptions ORDER BY id')).rows,
    processing:(await db.query("SELECT count(*)::int n FROM gate_event_outbox WHERE event_type='renewal.processing'")).rows[0].n});
  const reset=async()=>{
    await db.query('DELETE FROM renewal_jobs WHERE charge_id IN (SELECT ch.id FROM charges ch JOIN subscriptions s ON s.id=ch.subscription_id WHERE s.customer_id<>$1)',[one.customerId]);
    await db.query('DELETE FROM payments WHERE customer_id<>$1',[one.customerId]);
    await db.query('DELETE FROM customers WHERE id<>$1',[one.customerId]);
    await db.query("DELETE FROM subscriptions WHERE customer_id=$1 AND id<>$2",[one.customerId,one.subscriptionId]);
    await db.query("UPDATE customers SET bitpanel_reference=$2,bitpanel_owner=$3,status='active',automation_eligible=true WHERE id=$1",[one.customerId,one.username,OWNER]);
    await db.query("UPDATE subscriptions SET bitpanel_list_id=$2,expires_on='2026-11-01' WHERE id=$1",[one.subscriptionId,one.listId]);
    await db.query("UPDATE renewal_jobs SET status='awaiting_approval',core_status='READY',attempts=0,approved_at=NULL,completed_at=NULL,after_expiry=NULL WHERE id=$1",[one.renewalId]);
    await db.query("UPDATE payments SET status='CONFIRMED' WHERE id=$1",[one.payment]);
    await setSetting(db,'automatic_renewal_policy',policy);await setSetting(db,'global_pause',false);
  };
  return{pg,db,plan,one,subject,claim,verify,snapshot,reset};
}

test('financial binding guards block cross-customer aliases throughout reservation, submit and completion',async t=>{
  const originalFetch=globalThis.fetch;let network=0,actuations=0;
  globalThis.fetch=async()=>{network++;throw Error('NO_EXTERNAL_PROVIDER_IN_BINDING_TEST');};
  const f=await fixture();try{
    await t.test('a singular eligible paid account completes once and cannot submit again',async()=>{
      const claimed=await f.claim(f.one);assert.equal(claimed.automatic,true);
      assert.deepEqual(await f.verify(f.one),{verified:true});actuations++;
      await f.db.transaction(async client=>{
        assert.deepEqual(await f.verify(f.one,{client}),{verified:true});
        await client.query("UPDATE renewal_jobs SET status='completed',core_status='COMPLETED',completed_at=now(),after_expiry='2026-12-01' WHERE id=$1",[f.one.renewalId]);
        await client.query("UPDATE subscriptions SET expires_on='2026-12-01' WHERE id=$1",[f.one.subscriptionId]);
      });
      assert.deepEqual(await f.claim(f.one),{claimed:false,duplicate:true});
      await assert.rejects(f.verify(f.one),{code:'RENEWAL_RESULT_REQUIRES_REVIEW'});
    });
    await t.test('two customers with distinct official payments and the same list/login cannot reserve either renewal',async()=>{
      await f.reset();const other=await f.subject(),before=await f.snapshot();
      assert.notEqual(other.payment,f.one.payment);assert.notEqual(other.charge,f.one.charge);
      assert.deepEqual((await recoverPolicyRenewals(f.db,{now:NOW})).renewalIds,[]);
      for(const subject of [f.one,other])await assert.rejects(f.claim(subject),{code:'RENEWAL_BINDING_CONFLICT'});
      assert.deepEqual(await f.snapshot(),before);assert.equal(actuations,1);
    });
    await t.test('username aliases alone and historical list IDs on inactive accounts remain sensitive',async()=>{
      for(const variant of [{username:' SYNTHETIC.ACCESS ',listId:'654',status:'cancelled'},
        {username:'synthetic.other',listId:'00321',status:'suspended'}]){
        await f.reset();const other=await f.subject(variant);
        if(variant.listId==='00321')await f.db.query(`INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id)
          VALUES($1,$2,$3,'2027-01-01','654')`,[randomUUID(),other.customerId,f.plan]);
        const before=await f.snapshot();await assert.rejects(f.claim(f.one),{code:'RENEWAL_BINDING_CONFLICT'});
        assert.deepEqual(await f.snapshot(),before);
      }
      await f.db.query('UPDATE renewal_jobs SET approved_at=now() WHERE id=$1',[f.one.renewalId]);
      await setSetting(f.db,'automatic_renewal_policy',{enabled:false});
      await assert.rejects(f.claim(f.one),{code:'RENEWAL_BINDING_CONFLICT'});
    });
    await t.test('a conflicting alias created after claim blocks submit and rolls back completion',async()=>{
      await f.reset();await f.claim(f.one);await f.subject({username:'synthetic.other',listId:f.one.listId});
      const before=await f.snapshot();await assert.rejects(f.verify(f.one),{code:'RENEWAL_BINDING_CONFLICT'});
      await assert.rejects(f.db.transaction(async client=>{
        await f.verify(f.one,{client});
        await client.query("UPDATE subscriptions SET expires_on='2026-12-01' WHERE id=$1",[f.one.subscriptionId]);
      }),{code:'RENEWAL_BINDING_CONFLICT'});
      assert.deepEqual(await f.snapshot(),before);assert.equal(actuations,1);
    });
    await t.test('own relink, foreign customer context, refund and revoked policy are rechecked before submit',async()=>{
      for(const mutation of [
        ()=>f.db.query("UPDATE customers SET bitpanel_reference='synthetic.changed' WHERE id=$1",[f.one.customerId]),
        ()=>f.db.query("UPDATE subscriptions SET bitpanel_list_id='999' WHERE id=$1",[f.one.subscriptionId]),
        ()=>f.db.query("UPDATE subscriptions SET expires_on='2027-01-01' WHERE id=$1",[f.one.subscriptionId])]){
        await f.reset();await f.claim(f.one);await mutation();await assert.rejects(f.verify(f.one),{code:'RENEWAL_BINDING_CHANGED'});
      }
      await f.reset();await f.claim(f.one);await assert.rejects(f.verify({...f.one,customerId:randomUUID()}),{code:'RENEWAL_BINDING_CHANGED'});
      await f.db.query("UPDATE payments SET status='REFUNDED' WHERE id=$1",[f.one.payment]);
      await assert.rejects(f.verify(f.one),{code:'VERIFIED_PAYMENT_REQUIRED'});
      await f.db.query("UPDATE payments SET status='CONFIRMED' WHERE id=$1",[f.one.payment]);
      await setSetting(f.db,'automatic_renewal_policy',{...policy,enabled:false});
      await assert.rejects(f.verify(f.one),{code:'RENEWAL_APPROVAL_REQUIRED'});
      assert.equal(actuations,1);
    });
    await t.test('invalid bindings and correlation cannot touch the ledger; own historical subscriptions are not another customer',async()=>{
      await f.reset();const before=await f.snapshot();
      for(const patch of [{customerId:'bad'},{subscriptionId:randomUUID()},{listId:'0'},{listId:'321; DROP'},{username:' synthetic.access'},
        {username:'synthetic\naccess'},{owner:'Other reseller'}])
        await assert.rejects(f.db.transaction(client=>assertRenewalBindingUnique(client,{...f.one,...patch})),error=>
          ['RENEWAL_BINDING_INVALID','RENEWAL_BINDING_CHANGED'].includes(error.code));
      assert.deepEqual(await f.snapshot(),before);
      await f.db.query(`INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id)
        VALUES($1,$2,$3,'2025-01-01','321')`,[randomUUID(),f.one.customerId,f.plan]);
      await f.claim(f.one);await assert.rejects(f.verify({...f.one,correlationId:randomUUID()}),{code:'RENEWAL_RESULT_REQUIRES_REVIEW'});
      assert.deepEqual(await f.verify(f.one),{verified:true});
    });
    assert.equal(network,0);assert.equal(actuations,1);
    assert.equal((await f.db.query("SELECT value FROM system_settings WHERE key='renewal_requires_approval'")).rows[0].value,true);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM message_logs')).rows[0].n,0);
  }finally{await f.pg.close();globalThis.fetch=originalFetch;}
});
