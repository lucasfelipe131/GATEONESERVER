import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhase4EventHandlers } from '../src/services/phase4-event-handlers.js';
import { createBusinessEvent } from '../src/core/events.js';

test('payment.confirmed alone persists its renewal.ready continuation', async () => {
  const id='05500000-0000-4000-8000-000000000001';
  const emitted=[];
  const db={async query(sql,args){
    if(sql.includes('FROM renewal_jobs')) return {rows:[{renewal_id:id,payment_id:id,customer_id:id,
      subscription_id:id,subscription_customer_id:id,payment_status:'CONFIRMED',amount_cents:3000,
      expected_amount_cents:3000,previous_expiration:'2026-09-01',requested_extension_months:1,currency:'BRL'}]};
    if(sql.includes('INSERT INTO gate_event_outbox')) {emitted.push(args);return {rowCount:1,rows:[]};}
    return {rows:[],rowCount:0};
  }};
  const event=createBusinessEvent({eventType:'payment.confirmed',actor:{type:'SYSTEM',id:'fake'},subject:{type:'payment',id},payload:{customer_id:id}});
  const handlers=createPhase4EventHandlers({db,renewalOrchestrator:{start:async()=>({state:'READY'})}});
  await handlers['payment.confirmed'](event);
  assert.equal(emitted.length,1);
  assert.equal(emitted[0][1],'renewal.ready');
  assert.equal(emitted[0][4],event.correlation_id);
  assert.equal(emitted[0][5],event.event_id);
});
