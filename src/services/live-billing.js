import { createHash, randomUUID } from 'node:crypto';
import { SimulationBillingAutomation, createSimulationBilling } from './billing-automation.js';
import { getSetting } from '../db.js';
import { getRuntimeConfig } from '../integrations/runtime-config.js';
import { createCheckoutPreference, getMercadoPagoReadiness,
  searchMercadoPagoPreferences, getMercadoPagoPreference, getMercadoPagoAccount } from '../integrations/mercadopago.js';
import {moneyInCents} from './mercadopago-reconciliation.js';
import { classifyStage, dateOnlyInTimezone, renderChargeMessage } from '../domain/billing.js';
import { createBusinessEvent } from '../core/events.js';
import { appendOutboxEvent } from '../core/outbox.js';

const fail = code => Object.assign(new Error(code), {code});
export function liveBillingContext(env = process.env) {
  return env.NODE_ENV === 'production' && env.GATE_TEST_MODE === 'false' && env.PROVIDER_MODE === 'live' &&
    env.RAILWAY_PROJECT_ID === 'a0f107fe-acaf-459f-a640-38ef6010d1e5' &&
    env.RAILWAY_ENVIRONMENT_ID === '697f58fb-5084-4cb3-bd9a-ecdbc921b7bc';
}
export function notificationIdFor(key) {
  const bytes = createHash('sha256').update(key).digest().subarray(0,16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function validateLiveCheckout(checkout) {
  const url = new URL(checkout.checkoutUrl);
  if (checkout.simulated !== false || !checkout.id || String(checkout.id).startsWith('SIM-') ||
      String(checkout.id).length > 200 || url.protocol !== 'https:' || url.username || url.password ||
      !['www.mercadopago.com.br','mercadopago.com.br','www.mercadopago.com','mercadopago.com'].includes(url.hostname)) {
    throw fail('UNSAFE_LIVE_CHECKOUT');
  }
  return checkout;
}

export class LiveBillingAutomation extends SimulationBillingAutomation {
  constructor({db,assertEnabled,createCheckout,recoverCheckout}) {
    super({db,assertEnabled,createCheckout,baseUrl:'https://gateoneserver-production.up.railway.app'});
    this.recoverCheckout = recoverCheckout;
  }
  async reserve({customer_id:customerId,subscription_id:subscriptionId=null,plan_code:planCode=null,correlation_id:correlationId=randomUUID()}) {
    return this.db.transaction(async client => {
      const subscription = await this.subscription(client,{customerId,subscriptionId});
      let charge = (await client.query(`SELECT ch.*, COALESCE(ch.plan_id,s.plan_id) AS effective_plan_id
        FROM charges ch JOIN subscriptions s ON s.id=ch.subscription_id WHERE ch.subscription_id=$1
        AND ch.status IN ('draft','awaiting_approval','approved','sent')
        ORDER BY ch.created_at DESC LIMIT 1 FOR UPDATE OF ch`,[subscription.subscription_id])).rows[0];
      const existing = Boolean(charge);
      // A generic renewal request reuses the pending charge's plan. An explicit
      // change still requires review; never cancel or replace a pending payment.
      const plan = charge && !planCode
        ? (await client.query('SELECT * FROM plans WHERE active=true AND id=$1',[charge.effective_plan_id])).rows[0]
        : (await client.query('SELECT * FROM plans WHERE active=true AND code=$1',[planCode||subscription.plan_code])).rows[0];
      if (!plan) throw fail('PLAN_NOT_FOUND');
      if (charge && charge.effective_plan_id !== plan.id) throw fail('PENDING_PAYMENT_PLAN_CONFLICT');
      if (charge && (String(charge.mercado_pago_preference_id||'').startsWith('SIM-') ||
          String(charge.mercado_pago_payment_id||'').startsWith('SIM-'))) throw fail('SIMULATED_PAYMENT_REJECTED');
      if (!charge) {
        const key=`automatic-renewal:${subscription.subscription_id}:${subscription.expires_on}:${plan.id}`;
        charge=(await client.query(`INSERT INTO charges
          (subscription_id,plan_id,stage,status,amount_cents,due_on,idempotency_key,message_text,correlation_id)
          VALUES($1,$2,'manual','approved',$3,$4,$5,$6,$7)
          ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=charges.updated_at RETURNING *`,
          [subscription.subscription_id,plan.id,plan.price_cents,subscription.expires_on,key,
            renderChargeMessage({name:subscription.name,planName:plan.name,expiresOn:subscription.expires_on,amountCents:plan.price_cents,stage:'manual'}),correlationId])).rows[0];
      }
      if (!['draft','awaiting_approval','approved','sent'].includes(charge.status)) throw fail('BILLING_CYCLE_ALREADY_CLOSED');
      const payment=(await client.query(`INSERT INTO payments
        (customer_id,subscription_id,charge_id,provider,amount_cents,status,idempotency_key,correlation_id)
        VALUES($1,$2,$3,'mercadopago',$4,'PENDING',$5,$6)
        ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=payments.updated_at RETURNING *, (xmax=0) AS inserted`,
        [customerId,subscription.subscription_id,charge.id,charge.amount_cents,`live-checkout:${charge.id}`,correlationId])).rows[0];
      if (!['CREATED','PENDING'].includes(payment.status)) throw fail('PAYMENT_NOT_PENDING');
      if(payment.inserted) await appendOutboxEvent(client,createBusinessEvent({eventType:'payment.created',correlationId,
        actor:{type:'SERVICE',id:'live-billing'},subject:{type:'payment',id:payment.id},
        payload:{customer_id:customerId,subscription_id:subscription.subscription_id,charge_id:charge.id,simulated:false}}));
      await client.query(`INSERT INTO renewal_jobs
        (charge_id,payment_id,core_status,previous_expiration,requested_extension_months,idempotency_key,correlation_id)
        VALUES($1,$2,'WAITING_PAYMENT',$3,$4,$5,$6) ON CONFLICT(charge_id) DO NOTHING`,
        [charge.id,payment.id,subscription.expires_on,plan.duration_months,`renewal:${payment.id}`,correlationId]);
      await client.query(`INSERT INTO live_checkout_operations(charge_id,state,correlation_id,preference_id,checkout_url)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(charge_id) DO NOTHING`,
        [charge.id,'RESERVED',correlationId,charge.mercado_pago_preference_id,charge.checkout_url]);
      const operation=(await client.query('SELECT * FROM live_checkout_operations WHERE charge_id=$1 FOR UPDATE',[charge.id])).rows[0];
      const claimed=operation.state==='RESERVED';
      if (claimed) await client.query("UPDATE live_checkout_operations SET state='CREATING',updated_at=now() WHERE charge_id=$1",[charge.id]);
      return {subscription,plan,charge,payment,operation,claimed,existing,correlationId};
    });
  }
  async requestPayment(input) {
    await this.assertEnabled();
    const r=await this.reserve(input);
    if (r.operation.state==='READY') return this.result(r,validateLiveCheckout({id:r.operation.preference_id,checkoutUrl:r.operation.checkout_url,simulated:false}));
    if (!r.claimed && r.operation.state==='CREATING' && Date.now()-new Date(r.operation.updated_at).getTime()<45_000) throw fail('CHECKOUT_IN_PROGRESS');
    let checkout;
    try {
      await this.assertEnabled();
      checkout=r.claimed && !r.charge.mercado_pago_preference_id ? await this.createCheckout({...r.charge,customer_name:r.subscription.name,
        plan_name:r.plan.name,plan_code:r.plan.code,duration_months:r.plan.duration_months})
        : await this.recoverCheckout(r.charge);
      if (!checkout) throw fail('CHECKOUT_RESULT_REQUIRES_REVIEW');
      validateLiveCheckout(checkout);
      await this.db.transaction(async client => {
        const locked=(await client.query('SELECT * FROM charges WHERE id=$1 FOR UPDATE',[r.charge.id])).rows[0];
        if (!['draft','awaiting_approval','approved','sent'].includes(locked.status)) throw fail('CHARGE_CLOSED');
        await client.query(`UPDATE charges SET checkout_url=$2,mercado_pago_preference_id=$3,
          status=CASE WHEN status IN ('draft','awaiting_approval') THEN 'approved' ELSE status END,
          approved_at=COALESCE(approved_at,now()),updated_at=now() WHERE id=$1`,[r.charge.id,checkout.checkoutUrl,checkout.id]);
        await client.query("UPDATE live_checkout_operations SET state='READY',preference_id=$2,checkout_url=$3,failure_code=NULL,updated_at=now() WHERE charge_id=$1",
          [r.charge.id,checkout.id,checkout.checkoutUrl]);
      });
    } catch(error) {
      await this.db.query("UPDATE live_checkout_operations SET state='REVIEW',failure_code=$2,updated_at=now() WHERE charge_id=$1 AND state <> 'READY'",[r.charge.id,error.code||'CHECKOUT_RESPONSE_UNCERTAIN']);
      throw error;
    }
    return this.result(r,checkout);
  }
  result(r,checkout) {
    return {customer_id:r.subscription.customer_id,subscription_id:r.subscription.subscription_id,
      id:r.charge.id,name:r.subscription.name,plan_code:r.plan.code,plan_name:r.plan.name,
      charge_id:r.charge.id,payment_id:r.payment.id,status:r.payment.status,amount_cents:r.charge.amount_cents,
      currency:'BRL',checkout_url:checkout.checkoutUrl,existing:r.existing,simulated:false};
  }
  async queueReminder(row,payment,stage) {
    await this.assertEnabled();
    const id=notificationIdFor(`billing:${row.id}:${row.expires_on}:${stage}`),correlationId=randomUUID();
    const text=renderChargeMessage({name:row.name,planName:payment.plan_name||row.plan_name,expiresOn:row.expires_on,
      amountCents:payment.amount_cents,stage})+`\n\nPague pelo link seguro:\n${payment.checkout_url}`;
    return this.db.transaction(async client=>{
      const notice=await client.query(`INSERT INTO notification_requests(id,customer_id,channel,intention,context,priority,correlation_id)
        VALUES($1,$2,'WHATSAPP','BILLING_REMINDER',$3::jsonb,'NORMAL',$4) ON CONFLICT(id) DO NOTHING RETURNING id`,
        [id,row.customer_id,JSON.stringify({charge_id:payment.charge_id,stage,text,due_on:row.expires_on,simulated:false}),correlationId]);
      if(notice.rowCount) await appendOutboxEvent(client,createBusinessEvent({eventType:'notification.requested',correlationId,
        actor:{type:'SERVICE',id:'live-billing'},subject:{type:'notification',id},payload:{notification_id:id,customer_id:row.customer_id}}));
      return notice.rowCount;
    });
  }
  async requestChargeNotice({chargeId}) {
    const row=(await this.db.query(`SELECT s.id,s.customer_id,s.expires_on::text,c.name,ch.stage,ch.status
      FROM charges ch JOIN subscriptions s ON s.id=ch.subscription_id JOIN customers c ON c.id=s.customer_id
      WHERE ch.id=$1`,[chargeId])).rows[0];
    if(!row||!['approved','sent'].includes(row.status)) throw fail('APPROVED_CHARGE_REQUIRED');
    const payment=await this.requestPayment({customer_id:row.customer_id,subscription_id:row.id});
    if(payment.charge_id!==chargeId) throw fail('LEGACY_CHARGE_REQUIRES_REVIEW');
    return {queued:Boolean(await this.queueReminder(row,payment,row.stage)),chargeId};
  }
  async scanReminders({now=new Date(),timezone='America/Sao_Paulo'}={}) {
    await this.assertEnabled();
    if (await getSetting(this.db,'sales_mode','approval') !== 'automatic') return {skipped:true,reason:'APPROVAL_REQUIRED',simulated:false};
    const today=dateOnlyInTimezone(now,timezone);
    const candidates=await this.db.query(`SELECT s.id,s.customer_id,s.expires_on::text,c.name,p.name AS plan_name
      FROM subscriptions s JOIN customers c ON c.id=s.customer_id JOIN plans p ON p.id=s.plan_id
      WHERE s.status IN ('active','late') AND c.status <> 'cancelled' AND c.automation_eligible=true
      AND c.consent_contact=true AND c.opt_out_at IS NULL AND c.whatsapp_e164 IS NOT NULL AND p.active=true`);
    const stats={checked:candidates.rowCount,notifications:0,skipped:0,errors:0,simulated:false};
    for(const row of candidates.rows) {
      const stage=classifyStage(row.expires_on,today);
      if (!stage) {stats.skipped++;continue;}
      const id=notificationIdFor(`billing:${row.id}:${row.expires_on}:${stage}`);
      try {
        if ((await this.db.query('SELECT id FROM notification_requests WHERE id=$1',[id])).rowCount ||
            (await this.db.query("SELECT id FROM charges WHERE subscription_id=$1 AND due_on=$2 AND status='paid' LIMIT 1",[row.id,row.expires_on])).rowCount) {stats.skipped++;continue;}
        const payment=await this.requestPayment({customer_id:row.customer_id,subscription_id:row.id});
        const inserted=await this.queueReminder(row,payment,stage);
        stats.notifications+=inserted;
      } catch(error) {stats.errors++;stats.last_error_code=error.code||'LIVE_BILLING_FAILED';}
    }
    return stats;
  }
}

export function createBillingAutomation({db,config,env=process.env}) {
  if(!config.GATE_LIVE_BILLING_ENABLED) return createSimulationBilling({db,config,env});
  if(!liveBillingContext(env) || config.BILLING_AUTOMATION_ENABLED) throw fail('LIVE_BILLING_CONTEXT_REJECTED');
  const runtime=async () => {
    if(!liveBillingContext(env)) throw fail('LIVE_BILLING_CONTEXT_REJECTED');
    const r=await getRuntimeConfig(db,config);
    r.PAYMENT_MODE=await getSetting(db,'payment_mode',config.PAYMENT_MODE);
    if(r.PAYMENT_MODE!=='live' || !getMercadoPagoReadiness(r).ready || await getSetting(db,'global_pause',config.GLOBAL_PAUSE)) throw fail('LIVE_BILLING_PAUSED_OR_UNAVAILABLE');
    return r;
  };
  return new LiveBillingAutomation({db,assertEnabled:runtime,createCheckout:async charge => createCheckoutPreference(await runtime(),charge),
    recoverCheckout:async charge => {
      const r=await runtime();
      const found=charge.mercado_pago_preference_id?[{id:charge.mercado_pago_preference_id}]:await searchMercadoPagoPreferences(r,charge.id);
      if(found.length!==1) return null;
      const preference=await getMercadoPagoPreference(r,found[0].id);
      const account=await getMercadoPagoAccount(r);
      if(preference.external_reference !== charge.id || !Array.isArray(preference.items) || preference.items.length!==1 ||
          preference.items[0].currency_id!=='BRL' || preference.items[0].quantity!==1 ||
          moneyInCents(preference.items[0].unit_price)!==charge.amount_cents ||
          String(preference.collector_id)!==String(account.id)) throw fail('CHECKOUT_RECOVERY_MISMATCH');
      return {id:String(preference.id),checkoutUrl:preference.init_point,simulated:false};
    }});
}
