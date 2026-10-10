import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { hmacSha256 } from '../src/security.js';
import { verifyMercadoPagoWebhook, getMercadoPagoPaymentOptions } from '../src/integrations/mercadopago.js';
import { LiveBillingAutomation } from '../src/services/live-billing.js';
import { reconcileMercadoPagoPayment } from '../src/services/mercadopago-reconciliation.js';
import { liveEventHandlers, deliverCoreNotification } from '../src/services/live-outbox.js';
import { consumeEventIdempotently } from '../src/core/outbox.js';
import { PgConversationAgentRepository } from '../src/services/conversation-operations.js';
import { GateConversationAgent } from '../src/services/conversation-agent.js';
import { ConversationToolRegistry } from '../src/services/conversation-tools.js';
import { createCustomerContextSnapshot } from '../src/services/customer-context.js';
import { getCustomerContext, paymentOperationStatus, renewalOperationStatus } from '../src/services/gate-core.js';

// Exercises the production billing/reconciliation/notification code with mandatory
// injected fake providers. No production context or real transport is enabled.
export async function verifyWhatsAppPaymentFlow({ db, config, env = process.env }) {
  const guard = () => {
    assert.equal(env.RAILWAY_PROJECT_ID,'a0f107fe-acaf-459f-a640-38ef6010d1e5');
    assert.equal(env.RAILWAY_ENVIRONMENT_ID,'3f3188fb-0289-4f4d-93b9-574cfe1505f5');
    assert.equal(env.GATE_TEST_MODE,'true'); assert.equal(env.PROVIDER_MODE,'fake-only');
    for (const key of ['PAYMENT_MODE','WHATSAPP_MODE','BITPANEL_MODE']) {
      assert.equal(env[key],key === 'BITPANEL_MODE' ? 'disabled' : 'simulation');
      assert.equal(config[key],env[key]);
    }
  };
  guard();
  const count = async () => (await db.query(`SELECT
    (SELECT count(*)::int FROM customers) customers, (SELECT count(*)::int FROM subscriptions) subscriptions,
    (SELECT count(*)::int FROM charges) charges, (SELECT count(*)::int FROM payments) payments,
    (SELECT count(*)::int FROM renewal_jobs) renewals, (SELECT count(*)::int FROM agent_decisions) decisions,
    (SELECT count(*)::int FROM gate_event_outbox) events, (SELECT count(*)::int FROM notification_requests) notifications,
    (SELECT count(*)::int FROM gate_event_consumptions) consumptions, (SELECT count(*)::int FROM message_logs) messages`)).rows[0];
  const before = await count();
  const report = { commit:env.RAILWAY_GIT_COMMIT_SHA || null, verifiedAt:new Date().toISOString(),
    realProviderCalls:0, customerMessagesSent:0, realCheckouts:0, syntheticDeliveries:0, cases:[] };
  const rollback = new Error('PAYMENT_FLOW_SYNTHETIC_ROLLBACK');
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PAYMENT_VERIFIER'); };
  try {
    try {
      await db.transaction(async client => {
        const isolated = {query:(...args)=>client.query(...args),transaction:fn=>fn(client)};
        const plans = (await client.query('SELECT * FROM plans WHERE active=true ORDER BY sort_order')).rows;
        assert.deepEqual(new Set(plans.map(p=>p.code)),new Set(['monthly','quarterly','semiannual','annual']));
        for (const plan of plans) {
          guard();
          const customerId=randomUUID(), subscriptionId=randomUUID(), phone=`55119${randomInt(10000000,99999999)}`;
          assert.equal((await client.query('SELECT id FROM customers WHERE whatsapp_e164=$1',[`+${phone}`])).rowCount,0);
          await client.query("INSERT INTO customers(id,name,whatsapp_e164,status) VALUES($1,'Validação Sintética',$2,'active')",[customerId,`+${phone}`]);
          await client.query("INSERT INTO subscriptions(id,customer_id,plan_id,status,expires_on) VALUES($1,$2,$3,'active','2099-01-01')",[subscriptionId,customerId,plans.find(p=>p.code==='monthly').id]);
          let checkouts=0;
          const billing = new LiveBillingAutomation({db:isolated,assertEnabled:async()=>guard(),
            createCheckout:async charge=>{checkouts++;return {id:`synthetic-preference-${charge.id}`,
              checkoutUrl:`https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=synthetic-${charge.id}`,simulated:false};},
            recoverCheckout:async()=>{throw new Error('UNEXPECTED_CHECKOUT_RECOVERY');}});
          const scope=i=>({customerId:i.customer_id,subscriptionId:i.subscription_id||null});
          const repository=new PgConversationAgentRepository(isolated);
          const agent=new GateConversationAgent({repository,registry:new ConversationToolRegistry({handlers:{
            resolveCustomer:async()=>({status:'MATCHED',customer_id:customerId}),
            getCustomerContext:i=>createCustomerContextSnapshot(isolated,{customerId,purpose:i.purpose,channel:'WHATSAPP',requestedScopes:i.requested_scopes,correlationId:i.correlation_id}),
            getSubscription:async()=>{const c=await getCustomerContext(isolated,customerId);return {...c,status:c.subscription_status};},
            listPlans:async()=>plans,
            getPaymentOptions:()=>getMercadoPagoPaymentOptions(config),
            getPaymentStatus:i=>paymentOperationStatus(isolated,scope(i)),
            getRenewalStatus:i=>renewalOperationStatus(isolated,scope(i)),
            requestRenewal:i=>renewalOperationStatus(isolated,scope(i)),
            createPaymentRequest:i=>billing.requestPayment(i)
          }})});
          const turn=(text,messageId=randomUUID())=>agent.process({conversationId:`whatsapp:${phone}`,messageId,text,
            identity:{type:'WHATSAPP',provider:'whatsapp',value:phone}});
          const selection=await turn('quero renovar');
          assert.equal(selection.conversation_state,'awaiting_plan');
          assert.equal(selection.proposed_action,'listPlans'); assert.equal(checkouts,0);
          assert.equal((await client.query('SELECT count(*)::int n FROM payments WHERE customer_id=$1',[customerId])).rows[0].n,0);
          assert.match(selection.response_text,/TRIMESTRAL/);
          const messageId=randomUUID(), request=await turn(plan.name,messageId);
          assert.equal(request.proposed_action,'createPaymentRequest',JSON.stringify(request));
          assert.equal(request.response_facts.amount_cents,plan.price_cents);
          assert.equal(request.response_facts.plan_name,plan.name);
          assert.ok(request.response_facts.checkout_url); assert.equal(checkouts,1);
          assert.equal((await turn(plan.name,messageId)).duplicate,true);
          assert.equal((await turn('manda o pix')).response_facts.checkout_url,request.response_facts.checkout_url);
          assert.equal((await turn('paguei')).response_facts.payment_status,'PENDING');
          const payment=(await client.query('SELECT * FROM payments WHERE customer_id=$1',[customerId])).rows[0];
          const providerId=String(BigInt(`0x${randomUUID().replaceAll('-','').slice(0,16)}`));
          const raw={id:providerId,status:'approved',live_mode:true,currency_id:'BRL',transaction_amount:plan.price_cents/100,
            external_reference:payment.charge_id,collector_id:'synthetic-merchant'};
          const verify=raw=>reconcileMercadoPagoPayment({db:isolated,config:{PAYMENT_MODE:'live'},paymentId:providerId,
            getPayment:async()=>raw,getAccount:async()=>({id:'synthetic-merchant'})});
          const requestId=randomUUID(),ts=String(Math.floor(Date.now()/1000)),secret=randomUUID();
          const signature=`ts=${ts},v1=${hmacSha256(secret,`id:${providerId};request-id:${requestId};ts:${ts};`)}`;
          assert.equal(verifyMercadoPagoWebhook({config:{PAYMENT_MODE:'live',MERCADOPAGO_WEBHOOK_SECRET:secret},signature,requestId,dataId:providerId}),true);
          assert.equal(verifyMercadoPagoWebhook({config:{PAYMENT_MODE:'live',MERCADOPAGO_WEBHOOK_SECRET:secret},signature:'invalid',requestId,dataId:providerId}),false);
          assert.equal((await verify({...raw,status:'pending'})).confirmed,false);
          for (const patch of [{transaction_amount:raw.transaction_amount-0.01},{currency_id:'USD'},
            {collector_id:'other-merchant'},{live_mode:false},{external_reference:randomUUID()}]) {
            await assert.rejects(verify({...raw,...patch}));
          }
          assert.equal((await client.query('SELECT status FROM payments WHERE id=$1',[payment.id])).rows[0].status,'PENDING');
          assert.equal((await verify(raw)).confirmed,true);
          assert.equal((await verify(raw)).duplicate,true);
          assert.equal((await client.query('SELECT count(*)::int n FROM payments WHERE customer_id=$1',[customerId])).rows[0].n,1);
          assert.equal((await client.query('SELECT status FROM charges WHERE id=$1',[payment.charge_id])).rows[0].status,'paid');
          const events=(await client.query("SELECT * FROM gate_event_outbox WHERE event_type='payment.confirmed' AND subject->>'id'=$1",[payment.id])).rows;
          assert.equal(events.length,1);
          const jobs=new Map(),handlers=liveEventHandlers({queues:{messages:{add:async(name,data,options)=>jobs.set(options.jobId,{name,data})}}});
          const consume=event=>consumeEventIdempotently(isolated,{consumer:'synthetic-whatsapp-payment-flow',
            event:{...event,occurred_at:new Date(event.occurred_at).toISOString()}},c=>handlers[event.event_type](event,c));
          assert.equal((await consume(events[0])).processed,true); assert.equal((await consume(events[0])).duplicate,true);
          const notices=(await client.query("SELECT * FROM notification_requests WHERE customer_id=$1 AND intention='PAYMENT_CONFIRMED'",[customerId])).rows;
          assert.equal(notices.length,1);
          const noticeEvent=(await client.query("SELECT * FROM gate_event_outbox WHERE event_type='notification.requested' AND subject->>'id'=$1",[notices[0].id])).rows[0];
          await consume(noticeEvent); await consume(noticeEvent); assert.equal(jobs.size,1);
          let delivered=0;
          const send=async(_config,message)=>{
            assert.equal(message.to,`+${phone}`); assert.equal(message.deliveryKey,notices[0].id);
            assert.match(message.text,/pagamento.*confirmado/); assert.match(message.text,/verificação operacional/);
            assert.ok(message.text.includes(plan.name)); delivered++;
            return {ok:true,providerId:`synthetic-delivery-${payment.id}`};
          };
          for(const job of jobs.values()) await deliverCoreNotification({db:isolated,config:{},notificationId:job.data.notificationId,send});
          assert.equal((await deliverCoreNotification({db:isolated,config:{},notificationId:notices[0].id,send})).duplicate,true);
          assert.equal(delivered,1); report.syntheticDeliveries++;
          assert.equal((await turn('o pagamento foi confirmado?')).response_facts.payment_status,'CONFIRMED');
          assert.equal((await client.query('SELECT expires_on::text FROM subscriptions WHERE id=$1',[subscriptionId])).rows[0].expires_on,'2099-01-01');
          assert.equal((await client.query('SELECT count(*)::int n FROM renewal_jobs WHERE payment_id=$1',[payment.id])).rows[0].n,1);
          report.cases.push({plan:plan.code,amountCents:plan.price_cents,planSelection:'BEFORE_CHECKOUT',checkoutCalls:checkouts,
            customerReceipt:'PENDING',invalidProviderData:'REJECTED',confirmationEvents:1,notificationJobs:1,syntheticDeliveries:delivered,
            duplicateConfirmation:'NO_RESEND',subscriptionExpiration:'UNCHANGED'});
        }
        throw rollback;
      });
    } catch(error) { if(error!==rollback) throw error; }
    assert.deepEqual(await count(),before);
    return {...report,rolledBack:true,databaseCountsUnchanged:true};
  } finally { globalThis.fetch=fetchBefore; }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const config=loadConfig(),db=createDb(config.DATABASE_URL,{ssl:config.DATABASE_SSL});
  try { console.log('GATE_WHATSAPP_PAYMENT_FLOW_VERIFY='+JSON.stringify(await verifyWhatsAppPaymentFlow({db,config}))); }
  finally { await db.close(); }
}
