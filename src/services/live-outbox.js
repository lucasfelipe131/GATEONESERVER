import { OutboxDispatcher, appendOutboxEvent } from '../core/outbox.js';
import { startOutboxRuntime } from '../core/outbox-runtime.js';
import { createBusinessEvent } from '../core/events.js';
import { CORE_EVENT_TYPES } from '../core/contracts.js';
import { liveBillingContext, notificationIdFor } from './live-billing.js';

const fail=code=>Object.assign(new Error(code),{code});

export async function requestPaymentNotice(client,event) {
  const result=await client.query(`SELECT pay.*,ch.id AS charge_id,c.name,p.name AS plan_name
    FROM payments pay JOIN charges ch ON ch.id=pay.charge_id
    JOIN subscriptions s ON s.id=ch.subscription_id AND s.id=pay.subscription_id AND s.customer_id=pay.customer_id
    JOIN customers c ON c.id=pay.customer_id JOIN plans p ON p.id=COALESCE(ch.plan_id,s.plan_id)
    WHERE pay.id=$1 AND pay.status='CONFIRMED' AND ch.status='paid'`,[event.subject.id]);
  const row=result.rows[0];
  if(!row) throw fail('CONFIRMED_PAYMENT_REQUIRED');
  const id=notificationIdFor(`payment-confirmed:${row.id}`);
  const amount=(row.amount_cents/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const text=`✅ Olá, ${String(row.name||'cliente').split(/\s+/)[0]}! Seu pagamento de ${amount} foi confirmado.\nPlano: ${row.plan_name}.\nA renovação aguarda a verificação operacional. Se precisar, peça para falar com a equipe.`;
  const notice=await client.query(`INSERT INTO notification_requests(id,customer_id,channel,intention,context,priority,correlation_id,causation_id)
    VALUES($1,$2,'WHATSAPP','PAYMENT_CONFIRMED',$3::jsonb,'HIGH',$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [id,row.customer_id,JSON.stringify({charge_id:row.charge_id,payment_id:row.id,text,simulated:false}),event.correlation_id,event.event_id]);
  if(notice.rowCount) await appendOutboxEvent(client,createBusinessEvent({eventType:'notification.requested',correlationId:event.correlation_id,
    causationId:event.event_id,actor:{type:'SERVICE',id:'live-payment-notices'},subject:{type:'notification',id},payload:{notification_id:id,customer_id:row.customer_id}}));
}

export function liveEventHandlers({queues}) {
  const observed=async()=>({observed:true});
  return {
    ...Object.fromEntries(CORE_EVENT_TYPES.filter(type=>!['payment.confirmed','notification.requested'].includes(type)).map(type=>[type,observed])),
    'payment.confirmed':(event,client)=>requestPaymentNotice(client,event),
    'notification.requested':async(event,client)=>{
      const notice=(await client.query('SELECT * FROM notification_requests WHERE id=$1',[event.subject.id])).rows[0];
      if(!notice) throw fail('NOTIFICATION_NOT_FOUND');
      if(notice.status==='PENDING') await queues.messages.add('send-core-notification',{notificationId:notice.id},
        {jobId:`core-notice-${notice.id}`,attempts:8,backoff:{type:'exponential',delay:30_000},removeOnComplete:false,removeOnFail:false});
    },
    ...Object.fromEntries(['payment.created','payment.pending','payment.failed','payment.expired','payment.cancelled','payment.refunded',
      'payment.review_required','renewal.ready','renewal.requested','renewal.processing','renewal.verifying','renewal.completed',
      'renewal.failed','renewal.retry_scheduled','renewal.human_action_required','provisioning.requested','provisioning.processing',
      'provisioning.verifying','provisioning.completed','provisioning.failed','provisioning.human_action_required','customer.status_changed',
      'support.case_opened','support.case_updated','support.handoff_requested','conversation.turn_completed',
      'memory.created','memory.updated','context.snapshot_created'].map(type=>[type,observed]))
  };
}

export function startLiveOutbox({db,config,queues,workerId,env=process.env,logger=console}) {
  if(!config.GATE_LIVE_BILLING_ENABLED || !liveBillingContext(env)) throw fail('LIVE_OUTBOX_CONTEXT_REJECTED');
  const dispatcher=new OutboxDispatcher({db,workerId,consumerName:'gate-live.v1',handlers:liveEventHandlers({queues}),logger,env});
  logger.info({workerId},'LIVE_OUTBOX_STARTED');
  return startOutboxRuntime({dispatcher,logger});
}

export async function deliverCoreNotification({db,config,notificationId,send=sendQrDelivery}) {
  const notice=await db.transaction(async client=>{
    const row=(await client.query(`SELECT n.*,c.whatsapp_e164,c.consent_contact,c.opt_out_at,c.automation_eligible,
      ch.status AS charge_status,s.expires_on::text AS current_expiration FROM notification_requests n
      JOIN customers c ON c.id=n.customer_id LEFT JOIN charges ch ON ch.id=(n.context->>'charge_id')::uuid
      LEFT JOIN subscriptions s ON s.id=ch.subscription_id AND s.customer_id=n.customer_id
      WHERE n.id=$1 FOR UPDATE OF n`,[notificationId])).rows[0];
    if(!row) throw fail('NOTIFICATION_NOT_FOUND');
    if(row.status==='SENT' || row.status==='CANCELLED') return null;
    if(row.delivery_state==='REVIEW') throw fail('DELIVERY_REQUIRES_REVIEW');
    if(row.delivery_state==='SENDING' && Date.now()-new Date(row.updated_at).getTime()<45_000) throw fail('DELIVERY_IN_PROGRESS');
    const billing=row.intention==='BILLING_REMINDER';
    if(!row.whatsapp_e164 || row.opt_out_at || (billing && (!row.consent_contact || !row.automation_eligible ||
        row.charge_status==='paid' || row.current_expiration!==row.context.due_on))) {
      await client.query("UPDATE notification_requests SET status='CANCELLED',delivery_state='CANCELLED',updated_at=now() WHERE id=$1",[notificationId]);
      return null;
    }
    if(row.context.simulated !== false || !row.context.text) throw fail('UNSAFE_NOTIFICATION_CONTEXT');
    await client.query("UPDATE notification_requests SET delivery_state='SENDING',updated_at=now() WHERE id=$1",[notificationId]);
    return row;
  });
  if(!notice) return {duplicate:true};
  try {
    const result=await send(config,{to:notice.whatsapp_e164,text:notice.context.text,deliveryKey:notice.id});
    if(!result?.ok || !result.providerId) throw fail('QR_DELIVERY_UNCONFIRMED');
    await db.transaction(async client=>{
      await client.query("UPDATE notification_requests SET status='SENT',delivery_state='SENT',provider_message_id=$2,delivery_error=NULL,updated_at=now() WHERE id=$1",[notificationId,result.providerId]);
      await client.query(`INSERT INTO message_logs(customer_id,charge_id,direction,channel,content,provider_id,status,simulated)
        VALUES($1,$2,'outbound','whatsapp_qr',$3,$4,'sent',false)`,[notice.customer_id,notice.context.charge_id||null,notice.context.text,result.providerId]);
    });
    return result;
  } catch(error) {
    const review=['QR_DELIVERY_REQUIRES_REVIEW','QR_DELIVERY_UNCONFIRMED'].includes(error.code);
    await db.query("UPDATE notification_requests SET delivery_state=$2,delivery_error=$3,updated_at=now() WHERE id=$1 AND status <> 'SENT'",
      [notificationId,review?'REVIEW':'PENDING',error.code||'QR_TRANSPORT_UNAVAILABLE']);
    throw error;
  }
}

export async function sendQrDelivery(config,{to,text,deliveryKey}) {
  if(!config.GATE_ONE_WHATSAPP_QR_URL || !config.GATE_ONE_WHATSAPP_NOTIFY_SECRET) throw fail('QR_TRANSPORT_NOT_CONFIGURED');
  const response=await fetch(`${config.GATE_ONE_WHATSAPP_QR_URL.replace(/\/$/,'')}/api/gate-one/notify`,{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),headers:{'Content-Type':'application/json',
      'X-Gate-One-Notify-Secret':config.GATE_ONE_WHATSAPP_NOTIFY_SECRET},body:JSON.stringify({to,text,deliveryKey})});
  if(response.status===409) throw fail('QR_DELIVERY_REQUIRES_REVIEW');
  if(!response.ok) throw fail('QR_TRANSPORT_UNAVAILABLE');
  return response.json();
}
