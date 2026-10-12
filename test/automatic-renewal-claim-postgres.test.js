import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrateDatabase } from '../src/migrations.js';
import { claimRenewalExecution, recoverPolicyRenewals, invalidateCustomerAccessProvenance } from '../src/services/renewal-execution.js';

const NOW = new Date('2026-10-12T12:00:00Z');
const policy = () => ({ enabled:true,activatedAt:'2026-10-12T10:00:00Z',validatedAt:'2026-10-12T09:00:00Z',
  provider:'mercadopago',operation:'renew',planLabel:'30',maxConnections:1,unitPriceCents:100,maxCreditsPerRenewal:12,
  plans:{monthly:{durationMonths:1,priceCents:3000,creditCost:1},quarterly:{durationMonths:3,priceCents:8500,creditCost:3},
    semiannual:{durationMonths:6,priceCents:15000,creditCost:6},annual:{durationMonths:12,priceCents:27000,creditCost:12}} });

async function fixture() {
  const pg=new PGlite({extensions:{pgcrypto}});
  const adapter=handle=>({query:async(sql,params)=>{
    const result=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await handle.exec(sql)).at(-1):await handle.query(sql,params);
    return {...result,rowCount:result.rowCount??result.affectedRows??result.rows.length};
  }});
  const db={...adapter(pg),transaction:fn=>pg.transaction(tx=>fn(adapter(tx)))};
  await migrateDatabase(db);
  const plan=randomUUID(),customer=randomUUID(),subscription=randomUUID(),charge=randomUUID(),payment=randomUUID(),renewal=randomUUID(),correlation=randomUUID();
  await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Mensal',1,3000)",[plan]);
  await db.query("INSERT INTO customers(id,name,whatsapp_e164,bitpanel_reference,bitpanel_owner,automation_eligible) VALUES($1,'Cliente sintético','5511999999701','synthetic.access','Gate One Pro Server',true)",[customer]);
  await db.query("INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id) VALUES($1,$2,$3,'2026-11-01','321')",[subscription,customer,plan]);
  await db.query("INSERT INTO charges(id,subscription_id,plan_id,stage,status,amount_cents,due_on,idempotency_key,message_text) VALUES($1,$2,$3,'manual','paid',3000,'2026-11-01',$4,'Cobrança sintética')",[charge,subscription,plan,randomUUID()]);
  await db.query(`INSERT INTO payments(id,customer_id,subscription_id,charge_id,provider,external_payment_id,amount_cents,status,
    reconciliation_status,currency,confirmed_at,idempotency_key,correlation_id,provider_payload)
    VALUES($1,$2,$3,$4,'mercadopago','12345678',3000,'CONFIRMED','MATCHED','BRL','2026-10-12T11:00:00Z',$5,$6,
    '{"date_approved":"2026-10-12T11:00:00Z"}'::jsonb)`,[payment,customer,subscription,charge,randomUUID(),correlation]);
  await db.query("INSERT INTO renewal_jobs(id,charge_id,payment_id,status,core_status,requested_extension_months,previous_expiration) VALUES($1,$2,$3,'awaiting_approval','READY',1,'2026-11-01')",[renewal,charge,payment]);
  const setting=(key,value)=>db.query("INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[key,JSON.stringify(value)]);
  await setting('renewal_requires_approval',true);await setting('payment_mode','live');await setting('bitpanel_mode','live');
  await setting('automatic_renewal_policy',policy());
  const input={renewalId:renewal,correlationId:correlation,requiresApproval:true,now:NOW};
  const row=async()=> (await db.query('SELECT * FROM renewal_jobs WHERE id=$1',[renewal])).rows[0];
  const reset=async()=> {
    await db.query("UPDATE renewal_jobs SET status='awaiting_approval',core_status='READY',attempts=0,approved_at=NULL,completed_at=NULL,after_expiry=NULL,payment_id=$2 WHERE id=$1",[renewal,payment]);
    await db.query(`UPDATE payments SET status='CONFIRMED',reconciliation_status='MATCHED',provider='mercadopago',amount_cents=3000,
      currency='BRL',confirmed_at='2026-10-12T11:00:00Z',provider_payload='{"date_approved":"2026-10-12T11:00:00Z"}'::jsonb WHERE id=$1`,[payment]);
    await db.query("UPDATE charges SET status='paid',stage='manual',amount_cents=3000 WHERE id=$1",[charge]);
    await db.query("UPDATE customers SET automation_eligible=true,bitpanel_owner='Gate One Pro Server' WHERE id=$1",[customer]);
    await db.query('UPDATE plans SET price_cents=3000 WHERE id=$1',[plan]);
    await setting('automatic_renewal_policy',policy());await setting('global_pause',false);await setting('payment_mode','live');await setting('bitpanel_mode','live');
  };
  return {pg,db,plan,customer,subscription,charge,payment,renewal,input,setting,row,reset};
}

test('claim e recuperação revalidam política e razão financeira no banco sem custos ou mensagens externas',async t=>{
  const f=await fixture();
  try {
    await t.test('pagamento novo válido executa uma única reserva sem fingir aprovação humana',async()=>{
      const result=await claimRenewalExecution(f.db,f.input);
      assert.equal(result.claimed,true);assert.equal(result.automatic,true);assert.equal(result.creditCost,1);
      assert.equal(result.policy.planLabel,'30');assert.equal(result.policy.maxConnections,1);
      assert.equal(result.policy.unitPriceCents,100);
      assert.equal(result.renewal.plan_price_cents,3000);
      const saved=await f.row();assert.equal(saved.approved_at,null);assert.equal(saved.attempts,1);assert.equal(saved.status,'running');
      await assert.rejects(claimRenewalExecution(f.db,f.input),/RENEWAL_RESULT_REQUIRES_REVIEW/);
      assert.equal((await f.db.query("SELECT count(*)::int AS n FROM gate_event_outbox WHERE event_type='renewal.processing'")).rows[0].n,1);
    });
    await t.test('recuperação só coloca elegível na fila e claim relê política revogada depois',async()=>{
      await f.reset();
      const result=await recoverPolicyRenewals(f.db,{now:NOW});assert.deepEqual(result.renewalIds,[f.renewal]);
      let saved=await f.row();assert.equal(saved.status,'queued');assert.equal(saved.approved_at,null);assert.equal(saved.attempts,0);
      await f.setting('automatic_renewal_policy',{...policy(),enabled:false});
      await assert.rejects(claimRenewalExecution(f.db,f.input),/RENEWAL_APPROVAL_REQUIRED/);
      await f.reset();await f.db.query(`UPDATE payments SET provider_payload='{"date_approved":"2026-10-12T09:00:00Z"}'::jsonb WHERE id=$1`,[f.payment]);
      assert.deepEqual((await recoverPolicyRenewals(f.db,{now:NOW})).renewalIds,[]);
      await assert.rejects(claimRenewalExecution(f.db,f.input),/RENEWAL_APPROVAL_REQUIRED/);
      saved=await f.row();assert.equal(saved.attempts,0);assert.equal(saved.approved_at,null);
    });
    await t.test('histórico anterior à ativação e venda nova não entram na fila automática',async()=>{
      await f.reset();await f.db.query("UPDATE payments SET confirmed_at='2026-10-12T09:00:00Z' WHERE id=$1",[f.payment]);
      assert.deepEqual((await recoverPolicyRenewals(f.db,{now:NOW})).renewalIds,[]);
      await assert.rejects(claimRenewalExecution(f.db,f.input),/RENEWAL_APPROVAL_REQUIRED/);
      await f.reset();await f.db.query("UPDATE charges SET stage='new_sale' WHERE id=$1",[f.charge]);
      assert.deepEqual((await recoverPolicyRenewals(f.db,{now:NOW})).renewalIds,[]);
      await assert.rejects(claimRenewalExecution(f.db,f.input),/RENEWAL_APPROVAL_REQUIRED/);
    });
    await t.test('mapeamento, propriedade, custo ou reconciliação alterados bloqueiam claim',async()=>{
      for(const change of [
        ()=>f.db.query('UPDATE plans SET price_cents=2999 WHERE id=$1',[f.plan]),
        ()=>f.db.query('UPDATE customers SET automation_eligible=false WHERE id=$1',[f.customer]),
        ()=>f.db.query("UPDATE customers SET bitpanel_owner='outro revendedor' WHERE id=$1",[f.customer]),
        ()=>f.db.query("UPDATE payments SET reconciliation_status='REQUIRES_REVIEW' WHERE id=$1",[f.payment]),
        ()=>f.setting('automatic_renewal_policy',{...policy(),plans:{monthly:{durationMonths:1,priceCents:3000,creditCost:13}}})
      ]) {
        await f.reset();await change();await assert.rejects(claimRenewalExecution(f.db,f.input),/RENEWAL_APPROVAL_REQUIRED/);
        assert.equal((await f.row()).attempts,0);
      }
    });
    await t.test('payment é reconsultado sob lock, sem aceitar status capturado antes de um reembolso',async()=>{
      await f.reset();
      const raced={...f.db,transaction:fn=>f.db.transaction(client=>fn({query:async(sql,params)=>{
        if(sql.startsWith('SELECT * FROM payments WHERE id=$1 FOR UPDATE')) await client.query("UPDATE payments SET status='REFUNDED' WHERE id=$1",[f.payment]);
        return client.query(sql,params);
      }}))};
      await assert.rejects(claimRenewalExecution(raced,f.input),/VERIFIED_PAYMENT_REQUIRED/);
      assert.equal((await f.row()).attempts,0);
    });
    await t.test('modo simulado, pausa e flag runtime não concedem exceção',async()=>{
      await f.reset();await f.setting('bitpanel_mode','simulated');
      await assert.rejects(claimRenewalExecution(f.db,f.input),/RENEWAL_APPROVAL_REQUIRED/);
      assert.equal((await recoverPolicyRenewals(f.db,{now:NOW})).skipped,true);
      await f.reset();await f.setting('global_pause',true);
      await assert.rejects(claimRenewalExecution(f.db,f.input),/AUTOMATIONS_PAUSED/);
      await f.reset();await assert.rejects(claimRenewalExecution(f.db,{...f.input,allowAutomatic:false}),/RENEWAL_APPROVAL_REQUIRED/);
    });
    await t.test('aprovação humana continua válida com política automática desabilitada',async()=>{
      await f.reset();await f.setting('automatic_renewal_policy',{enabled:false});
      await f.db.query('UPDATE renewal_jobs SET approved_at=now() WHERE id=$1',[f.renewal]);
      const result=await claimRenewalExecution(f.db,f.input);assert.equal(result.claimed,true);assert.equal(result.automatic,false);
      assert.equal(result.policy,null);assert.equal(result.creditCost,null);
    });
    await t.test('nova validade invalida proveniência para próxima leitura sem expor ou apagar senha',async()=>{
      await f.db.query(`INSERT INTO customer_access_sync(customer_id,subscription_id,list_id,username,owner,verified_whatsapp_e164,
        source_url,verified_at,attempted_at,status) VALUES($1,$2,'321','synthetic.access','Gate One Pro Server','5511999999701',
        'https://bitpanel.vip/list/view/321',now(),now(),'READY')`,[f.customer,f.subscription]);
      await f.db.transaction(client=>invalidateCustomerAccessProvenance(client,f.customer));
      const access=(await f.db.query('SELECT * FROM customer_access_sync WHERE customer_id=$1',[f.customer])).rows[0];
      assert.equal(access.status,'STALE');assert.equal(access.verified_at,null);
      assert.ok(new Date(access.attempted_at)<new Date(Date.now()-15*60_000));
      assert.equal(access.last_error_code,'BITPANEL_ACCESS_REFRESH_REQUIRED');
    });
    assert.equal((await f.db.query('SELECT value FROM system_settings WHERE key=$1',['renewal_requires_approval'])).rows[0].value,true);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM message_logs')).rows[0].n,0);
  } finally { await f.pg.close(); }
});
