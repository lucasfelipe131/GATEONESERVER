import { createHash, randomUUID } from 'node:crypto';
import { createBusinessEvent } from '../core/events.js';
import { appendOutboxEvent } from '../core/outbox.js';
import { notificationRequested } from '../core/notifications.js';
import { classifyStage, dateOnlyInTimezone, renderChargeMessage } from '../domain/billing.js';
import { getSetting } from '../db.js';
import { localSupportEnabled } from './support-repository.js';
import { createCheckoutPreference } from '../integrations/mercadopago.js';

const failure = code => Object.assign(new Error(code), { code });

function reminderId(key) {
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Durable simulated operations through the existing Mercado Pago adapter.
// Guards prevent its live branch. Both entry points share the subscription lock.
export class SimulationBillingAutomation {
  constructor({ db, baseUrl, assertEnabled, createCheckout }) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('INVALID_CHECKOUT_BASE_URL');
    this.db = db;
    this.baseUrl = url.origin;
    this.assertEnabled = assertEnabled;
    this.createCheckout = createCheckout;
  }

  async subscription(client, { customerId, subscriptionId = null }) {
    const result = await client.query(`SELECT s.id AS subscription_id, s.customer_id, s.expires_on::text,
      c.name, c.whatsapp_e164, c.consent_contact, c.opt_out_at, c.automation_eligible,
      p.id AS plan_id, p.code AS plan_code, p.name AS plan_name, p.duration_months, p.price_cents
      FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id
      WHERE s.customer_id = $1 AND ($2::uuid IS NULL OR s.id = $2)
        AND s.status IN ('active','late') AND c.status <> 'cancelled' AND p.active = true
      ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE OF s`, [customerId, subscriptionId]);
    if (!result.rows[0]) throw failure('SUBSCRIPTION_NOT_FOUND');
    return result.rows[0];
  }

  async ensurePayment(client, subscription, { planCode = null, correlationId }) {
    const pending = await client.query(`SELECT ch.*, COALESCE(ch.plan_id,s.plan_id) AS effective_plan_id
      FROM charges ch JOIN subscriptions s ON s.id = ch.subscription_id
      WHERE ch.subscription_id = $1 AND ch.status IN ('draft','awaiting_approval','approved','sent')
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.charge_id = ch.id AND p.status IN ('CONFIRMED','FAILED','EXPIRED','CANCELLED','REFUNDED'))
      ORDER BY ch.created_at DESC LIMIT 1 FOR UPDATE OF ch`, [subscription.subscription_id]);
    const plans = await client.query(`SELECT id, code, name, duration_months, price_cents FROM plans
      WHERE active = true AND code = $1`, [planCode || subscription.plan_code]);
    const plan = plans.rows[0];
    if (!plan) throw failure('PLAN_NOT_FOUND');
    let charge = pending.rows[0];
    if (charge && charge.effective_plan_id !== plan.id) throw failure('PENDING_PAYMENT_PLAN_CONFLICT');
    // A legacy live checkout must never be relabelled as a simulation.
    if (charge && ((charge.mercado_pago_payment_id && !charge.mercado_pago_payment_id.startsWith('SIM-')) ||
        (charge.mercado_pago_preference_id && !charge.mercado_pago_preference_id.startsWith('SIM-PREF-')))) throw failure('EXISTING_PROVIDER_PAYMENT_REQUIRES_REVIEW');
    const existing = Boolean(charge);
    if (!charge) {
      const key = `automatic-renewal:${subscription.subscription_id}:${subscription.expires_on}:${plan.id}`;
      const result = await client.query(`INSERT INTO charges
        (subscription_id,plan_id,stage,status,amount_cents,due_on,idempotency_key,message_text,correlation_id)
        VALUES($1,$2,'manual','approved',$3,$4,$5,$6,$7)
        ON CONFLICT(idempotency_key) DO UPDATE SET updated_at = charges.updated_at RETURNING *`,
      [subscription.subscription_id,plan.id,plan.price_cents,subscription.expires_on,key,
        renderChargeMessage({name:subscription.name,planName:plan.name,expiresOn:subscription.expires_on,amountCents:plan.price_cents,stage:'manual'}),correlationId]);
      charge = result.rows[0];
      if (['paid','rejected','cancelled','expired'].includes(charge.status)) throw failure('BILLING_CYCLE_ALREADY_CLOSED');
    }
    const externalId = `simulation:${charge.id}`;
    const checkout = charge.checkout_url && charge.mercado_pago_preference_id?.startsWith('SIM-PREF-')
      ? {id:charge.mercado_pago_preference_id,checkoutUrl:charge.checkout_url,simulated:true}
      : await this.createCheckout({...charge,customer_name:subscription.name,customer_phone:subscription.whatsapp_e164,
        plan_code:plan.code,plan_name:plan.name,duration_months:plan.duration_months});
    if (checkout.simulated !== true || !checkout.id?.startsWith('SIM-PREF-') ||
        checkout.checkoutUrl !== `${this.baseUrl}/pagamento?status=simulation&charge=${encodeURIComponent(charge.id)}`) throw failure('UNSAFE_CHECKOUT_RESULT');
    const checkoutUrl = checkout.checkoutUrl;
    const payment = await client.query(`INSERT INTO payments
      (customer_id,subscription_id,charge_id,provider,external_payment_id,amount_cents,status,idempotency_key,correlation_id)
      VALUES($1,$2,$3,'fake',$4,$5,'PENDING',$4,$6)
      ON CONFLICT(idempotency_key) DO UPDATE SET updated_at = payments.updated_at RETURNING *, (xmax = 0) AS inserted`,
    [subscription.customer_id,subscription.subscription_id,charge.id,externalId,charge.amount_cents,correlationId]);
    const row = payment.rows[0];
    if (!['CREATED','PENDING'].includes(row.status)) throw failure('PAYMENT_NOT_PENDING');
    await client.query(`UPDATE charges SET checkout_url = $2, mercado_pago_preference_id = $3, updated_at = now() WHERE id = $1`, [charge.id,checkoutUrl,checkout.id]);
    await client.query(`INSERT INTO renewal_jobs
      (charge_id,payment_id,core_status,previous_expiration,requested_extension_months,idempotency_key,correlation_id)
      VALUES($1,$2,'WAITING_PAYMENT',$3,$4,$5,$6) ON CONFLICT(charge_id) DO NOTHING`,
    [charge.id,row.id,subscription.expires_on,plan.duration_months,`renewal:${row.id}`,correlationId]);
    if (row.inserted) await appendOutboxEvent(client, createBusinessEvent({
      eventType:'payment.created', correlationId, actor:{type:'SERVICE',id:'billing-automation-simulation'},
      subject:{type:'payment',id:row.id}, payload:{customer_id:subscription.customer_id,subscription_id:subscription.subscription_id,charge_id:charge.id,simulated:true}
    }));
    return {customer_id:subscription.customer_id,subscription_id:subscription.subscription_id,charge_id:charge.id,
      payment_id:row.id,status:row.status,amount_cents:charge.amount_cents,currency:row.currency,
      checkout_url:checkoutUrl,existing:existing || !row.inserted,simulated:true};
  }

  async requestPayment({ customer_id: customerId, subscription_id: subscriptionId = null, plan_code: planCode = null, correlation_id: correlationId = randomUUID() }) {
    await this.assertEnabled();
    return this.db.transaction(async client => this.ensurePayment(client,
      await this.subscription(client, {customerId,subscriptionId}), {planCode,correlationId}));
  }

  async scanReminders({ now = new Date(), timezone = 'America/Sao_Paulo' } = {}) {
    await this.assertEnabled();
    const today = dateOnlyInTimezone(now, timezone);
    const candidates = await this.db.query(`SELECT s.id, s.customer_id FROM subscriptions s
      JOIN customers c ON c.id = s.customer_id WHERE s.status IN ('active','late')
      AND c.status <> 'cancelled' AND c.automation_eligible = true`);
    const stats = {checked:candidates.rowCount,created:0,skipped:0,notifications:0,errors:0,simulated:true};
    for (const candidate of candidates.rows) {
      try {
        const result = await this.db.transaction(async client => {
          const subscription = await this.subscription(client, {customerId:candidate.customer_id,subscriptionId:candidate.id});
          const stage = classifyStage(subscription.expires_on,today);
          if (!stage || !subscription.automation_eligible || !subscription.consent_contact || subscription.opt_out_at || !subscription.whatsapp_e164) return null;
          const paid = await client.query(`SELECT ch.id FROM charges ch LEFT JOIN payments p ON p.charge_id = ch.id
            WHERE ch.subscription_id = $1 AND ch.due_on = $2 AND (ch.status = 'paid' OR p.status = 'CONFIRMED') LIMIT 1`,
          [subscription.subscription_id,subscription.expires_on]);
          if (paid.rowCount) return null;
          const notificationId = reminderId(`billing:${subscription.subscription_id}:${subscription.expires_on}:${stage}`);
          if ((await client.query('SELECT id FROM notification_requests WHERE id = $1',[notificationId])).rowCount) return null;
          const correlationId = randomUUID();
          const payment = await this.ensurePayment(client,subscription,{correlationId});
          const text = `[Simulação] ${renderChargeMessage({name:subscription.name,planName:subscription.plan_name,
            expiresOn:subscription.expires_on,amountCents:payment.amount_cents,stage})}\n${payment.checkout_url}`;
          const notification = notificationRequested({notificationId,customerId:subscription.customer_id,channel:'WHATSAPP',
            intention:'BILLING_REMINDER',context:{charge_id:payment.charge_id,stage,due_on:subscription.expires_on,text,simulated:true},correlationId});
          const inserted = await client.query(`INSERT INTO notification_requests
            (id,customer_id,channel,intention,context,priority,correlation_id)
            VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`,
          [notificationId,subscription.customer_id,notification.channel,notification.intention,JSON.stringify(notification.context),notification.priority,correlationId]);
          if (inserted.rowCount) await appendOutboxEvent(client,createBusinessEvent({eventType:'notification.requested',correlationId,
            actor:{type:'SERVICE',id:'billing-automation-simulation'},subject:{type:'notification',id:notificationId},payload:notification}));
          return {created:!payment.existing,notification:inserted.rowCount > 0};
        });
        if (!result) stats.skipped++;
        else { if (result.created) stats.created++; if (result.notification) stats.notifications++; }
      } catch (error) {
        stats.errors++;
        stats.last_error_code = error.code || 'BILLING_SCAN_FAILED';
      }
    }
    return stats;
  }
}

export function createSimulationBilling({db, config, env = process.env}) {
  if (!config.BILLING_AUTOMATION_ENABLED) return null;
  const guard = () => {
    if (!localSupportEnabled(env) || env.PROVIDER_MODE !== 'fake-only' ||
        env.PAYMENT_MODE !== 'simulation' || env.WHATSAPP_MODE !== 'simulation' || env.BITPANEL_MODE !== 'disabled' ||
        config.PAYMENT_MODE !== 'simulation' || config.WHATSAPP_MODE !== 'simulation' || config.BITPANEL_MODE !== 'disabled') throw failure('BILLING_SIMULATION_GUARD_FAILED');
  };
  guard();
  const baseUrl = config.PUBLIC_BASE_URL || 'http://localhost:3000';
  return new SimulationBillingAutomation({db,baseUrl,createCheckout:charge => createCheckoutPreference({...config,PUBLIC_BASE_URL:new URL(baseUrl).origin},charge),assertEnabled:async () => {
    guard();
    const modes = await Promise.all(['payment_mode','whatsapp_mode','bitpanel_mode'].map(key => getSetting(db,key,null)));
    if (modes.some((mode,index) => mode !== ['simulation','simulation','disabled'][index])) throw failure('BILLING_SIMULATION_SETTINGS_MISMATCH');
  }});
}
