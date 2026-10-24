import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {setSetting} from '../src/db.js';
import {assertCustomerHubActivationPreflight} from '../scripts/customer-hub-activate.js';

test('activation preflight rejects unsafe settings and historical human approvals without changing data',async t=>{
  const pg=new PGlite({extensions:{pgcrypto}}),adapt=handle=>({query:async(sql,params)=>{
    const r=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await handle.exec(sql)).at(-1):await handle.query(sql,params);
    return{...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};
  }}),db={...adapt(pg),transaction:fn=>pg.transaction(tx=>fn(adapt(tx)))};
  const defaults={payment_mode:'live',global_pause:false,bitpanel_mode:'disabled',renewal_requires_approval:true};
  const reset=async()=>{for(const [key,value] of Object.entries(defaults))await setSetting(db,key,value);};
  try{
    await migrateDatabase(db);await reset();
    const plan=randomUUID(),subjects=[];
    await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Synthetic plan',1,3000)",[plan]);
    for(const [index,owner,eligible,reference,list] of [
      [0,' GÁTE - ONE PRO SERVER ',true,'synthetic.one','12345'],
      [1,'Gate One Pro Server',true,'synthetic.two','54321'],
      [2,'Gate One Pro Server',false,'synthetic.three','33333'],
      [3,'Other reseller',true,'synthetic.four','44444'],
      [4,'Gate One Server',true,'synthetic.five','55555'],
      [5,'Gate One Pro Server',true,null,'66666']
    ]){
      const customer=randomUUID(),subscription=randomUUID();subjects.push({customer,subscription});
      await db.query(`INSERT INTO customers(id,name,whatsapp_e164,bitpanel_owner,automation_eligible,bitpanel_reference)
        VALUES($1,'Synthetic preflight',$2,$3,$4,$5)`,[customer,`55119999996${String(index).padStart(2,'0')}`,owner,eligible,reference]);
      await db.query(`INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id,created_at)
        VALUES($1,$2,$3,'2099-01-01',$4,now()-interval '1 day')`,[subscription,customer,plan,list]);
    }
    // An older linked subscription cannot qualify a customer whose current one
    // lacks a list; multiple historical subscriptions cannot duplicate counts.
    for(const [index,list] of [[0,'22222'],[1,null]])await db.query(`INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id)
      VALUES($1,$2,$3,'2099-01-01',$4)`,[randomUUID(),subjects[index].customer,plan,list]);
    await t.test('counts normalized owners once and uses only the latest subscription',async()=>{
      assert.deepEqual(await assertCustomerHubActivationPreflight(db),{bitpanelMode:'disabled',eligibleCustomers:2,pendingHumanApprovedRenewals:0});
      assert.deepEqual(await db.transaction(client=>assertCustomerHubActivationPreflight(client,{lock:true})),
        {bitpanelMode:'disabled',eligibleCustomers:2,pendingHumanApprovedRenewals:0});
    });
    await t.test('missing or unsafe runtime settings fail before activation',async()=>{
      for(const [key,value,error] of [
        ['payment_mode','fake','PAYMENT_MODE_MUST_BE_LIVE'],
        ['global_pause',true,'AUTOMATIONS_MUST_BE_UNPAUSED'],
        ['bitpanel_mode','dry-run','BITPANEL_MODE_MUST_BE_DISABLED_OR_LIVE'],
        ['renewal_requires_approval',false,'GLOBAL_RENEWAL_APPROVAL_MUST_REMAIN_REQUIRED']
      ]){
        await setSetting(db,key,value);await assert.rejects(assertCustomerHubActivationPreflight(db),new RegExp(error));
        assert.deepEqual((await db.query('SELECT value FROM system_settings WHERE key=$1',[key])).rows[0].value,value);
        await reset();
      }
      await db.query("DELETE FROM system_settings WHERE key='global_pause'");
      await assert.rejects(assertCustomerHubActivationPreflight(db),/AUTOMATIONS_MUST_BE_UNPAUSED/);await reset();
    });
    const charge=randomUUID(),renewal=randomUUID();
    await db.query(`INSERT INTO charges(id,subscription_id,stage,status,amount_cents,due_on,idempotency_key,message_text)
      VALUES($1,$2,'manual','sent',3000,'2099-01-01',$3,'Synthetic preflight')`,[charge,subjects[0].subscription,`preflight:${charge}`]);
    await db.query(`INSERT INTO renewal_jobs(id,charge_id,status,core_status,approved_at,attempts)
      VALUES($1,$2,'awaiting_approval','READY',now(),0)`,[renewal,charge]);
    await t.test('pending human approvals with READY or legacy null core prevent disabled to live',async()=>{
      for(const core of ['READY',null]){
        await db.query('UPDATE renewal_jobs SET core_status=$2 WHERE id=$1',[renewal,core]);
        await assert.rejects(assertCustomerHubActivationPreflight(db),/PENDING_HUMAN_APPROVED_RENEWALS_BLOCK_LIVE_TRANSITION/);
        await assert.rejects(db.transaction(client=>assertCustomerHubActivationPreflight(client,{lock:true})),
          /PENDING_HUMAN_APPROVED_RENEWALS_BLOCK_LIVE_TRANSITION/);
      }
      assert.equal((await db.query('SELECT attempts FROM renewal_jobs WHERE id=$1',[renewal])).rows[0].attempts,0);
      assert.equal((await db.query("SELECT value FROM system_settings WHERE key='bitpanel_mode'")).rows[0].value,'disabled');
    });
    await t.test('completed, attempted and unapproved jobs do not represent releasable human approvals; a live rerun reports them',async()=>{
      for(const patch of ["status='completed',attempts=0,core_status='READY'","status='awaiting_approval',attempts=1,core_status='READY'",
        "attempts=0,core_status='PROCESSING'","core_status='READY',approved_at=NULL"]){
        await db.query(`UPDATE renewal_jobs SET ${patch} WHERE id=$1`,[renewal]);
        assert.equal((await assertCustomerHubActivationPreflight(db)).pendingHumanApprovedRenewals,0);
      }
      await db.query("UPDATE renewal_jobs SET core_status='READY',approved_at=now() WHERE id=$1",[renewal]);
      await setSetting(db,'bitpanel_mode','live');
      assert.equal((await assertCustomerHubActivationPreflight(db)).pendingHumanApprovedRenewals,1);
      assert.equal((await db.query("SELECT value FROM system_settings WHERE key='renewal_requires_approval'")).rows[0].value,true);
    });
    assert.equal((await db.query('SELECT count(*)::int n FROM payments')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM message_logs')).rows[0].n,0);
  }finally{await pg.close();}
});
