import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { loadConfig } from '../src/config.js';
import { createDb, setSetting } from '../src/db.js';
import { registerCustomerPortal, PORTAL_COOKIE } from '../src/customer-portal-routes.js';
import { PRIVACY_NOTICE_VERSION } from '../src/services/customer-portal.js';
import { LiveBillingAutomation } from '../src/services/live-billing.js';
import { PgConversationAgentRepository } from '../src/services/conversation-operations.js';
import { requestPaymentNotice, deliverCoreNotification } from '../src/services/live-outbox.js';

const counts=async db=>{
  const tables=['customers','subscriptions','charges','payments','renewal_jobs','conversation_handoffs','customer_portal_links','customer_portal_sessions','customer_privacy_events','customer_privacy_requests','customer_identity_links','notification_requests','message_logs','gate_event_outbox'];
  const result={};for(const table of tables)result[table]=(await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;return result;
};
export async function verifyCustomerPortal({db,config,env=process.env}) {
  assert.equal(env.RAILWAY_PROJECT_ID,'a0f107fe-acaf-459f-a640-38ef6010d1e5');
  assert.equal(env.RAILWAY_ENVIRONMENT_ID,'3f3188fb-0289-4f4d-93b9-574cfe1505f5');
  assert.equal(env.GATE_TEST_MODE,'true');assert.equal(env.PROVIDER_MODE,'fake-only');
  for(const modes of [env,config]){assert.equal(modes.PAYMENT_MODE,'simulation');assert.equal(modes.WHATSAPP_MODE,'simulation');assert.equal(modes.BITPANEL_MODE,'disabled');}
  const before=await counts(db),rollback=Symbol('portal-rollback'),originalFetch=globalThis.fetch;
  let report,providerCalls=0;
  globalThis.fetch=async()=>{throw new Error('NETWORK_FORBIDDEN_IN_PORTAL_VERIFIER');};
  try {
    await db.transaction(async client=>{
      const scoped={query:(...args)=>client.query(...args),transaction:fn=>fn(client)};
      await setSetting(scoped,'privacy_controller_name','Responsável Sintético');await setSetting(scoped,'privacy_contact','privacidade@example.invalid');
      const customer=randomUUID(),other=randomUUID(),subscription=randomUUID(),phone='5511999999701';
      await client.query(`INSERT INTO customers(id,name,email,whatsapp_e164,bitpanel_reference,status,consent_contact,automation_eligible)
        VALUES($1,'Pessoa Sintética','pessoa@example.invalid',$2,'sintetico.portal','active',true,true),
        ($3,'Outra Pessoa','outra-conta@example.invalid','5511999999702','outra.conta','active',true,true)`,[customer,phone,other]);
      const plan=(await client.query("SELECT id FROM plans WHERE code='monthly' AND active=true")).rows[0];assert.ok(plan);
      await client.query(`INSERT INTO subscriptions(id,customer_id,plan_id,starts_on,expires_on,status) VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE+7,'active')`,[subscription,customer,plan.id]);
      const billing=new LiveBillingAutomation({db:scoped,assertEnabled:async()=>{},createCheckout:async charge=>{providerCalls++;return {id:`synthetic-portal-${charge.id}`,checkoutUrl:`https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=synthetic-portal-${charge.id}`,simulated:false};},recoverCheckout:async()=>{throw new Error('unexpected recovery');}});
      const app=Fastify({logger:false});await app.register(cookie);
      const testConfig={...config,NODE_ENV:'production',COOKIE_SECRET:'synthetic-portal-cookie-secret',PUBLIC_BASE_URL:'https://portal.example.invalid',PUBLIC_WHATSAPP_NUMBER:'5511999999700'};
      const portal=registerCustomerPortal(app,{db:scoped,config:testConfig,billingAutomation:billing,getPaymentOptions:async()=>({methods:['Pix','Cartão de crédito','Boleto'],simulated:false}),requireBotSecret:(request,reply)=>{
        if(request.headers['x-bot-test']!=='synthetic') {reply.code(401).send({error:'Unauthorized'});return false;}return true;
      }});
      try {
        assert.equal((await app.inject({url:'/api/portal/me'})).statusCode,401);
        assert.equal((await app.inject({method:'POST',url:'/api/integrations/whatsapp/portal',payload:{whatsapp:phone,messageId:'unauth'}})).statusCode,401);
        const issue=await app.inject({method:'POST',url:'/api/integrations/whatsapp/portal',headers:{'x-bot-test':'synthetic'},payload:{whatsapp:phone,messageId:'portal-request'}});
        assert.equal(issue.statusCode,200,issue.body);const issued=issue.json();assert.match(issued.portalUrl,/\/cliente#[A-Za-z0-9_-]+$/);
        assert.equal((await portal.issueWhatsAppLink({phone,messageId:'portal-request'})).portalUrl,issued.portalUrl);
        const token=new URL(issued.portalUrl).hash.slice(1);
        const login=await app.inject({method:'POST',url:'/api/portal/session',headers:{origin:testConfig.PUBLIC_BASE_URL},payload:{token}});
        assert.equal(login.statusCode,200,login.body);assert.match(login.headers['set-cookie'],/HttpOnly/i);assert.match(login.headers['set-cookie'],/Secure/i);
        const cookieHeader=login.headers['set-cookie'].split(';')[0];assert.ok(cookieHeader.startsWith(PORTAL_COOKIE+'='));
        assert.equal((await app.inject({method:'POST',url:'/api/portal/session',payload:{token}})).statusCode,401);
        const me=await app.inject({url:'/api/portal/me',headers:{cookie:cookieHeader}});assert.equal(me.statusCode,200,me.body);
        const account=me.json();assert.equal(account.login,'sintetico.portal');assert.deepEqual(account.payment_methods,['Pix','Cartão de crédito','Boleto']);
        assert.doesNotMatch(me.body,/outra-conta|outra\.conta|password|encrypted|customer_id/);
        assert.match(me.headers['cache-control'],/no-store/);
        const headers={cookie:cookieHeader,origin:testConfig.PUBLIC_BASE_URL,'x-portal-csrf':account.csrf_token};
        const profile={name:'Nome Atualizado',email:'',claimedLogin:'',noticeAcknowledged:true,noticeVersion:PRIVACY_NOTICE_VERSION,consentContact:false};
        assert.equal((await app.inject({method:'PATCH',url:'/api/portal/me/profile',headers:{cookie:cookieHeader},payload:profile})).statusCode,403);
        assert.equal((await app.inject({method:'PATCH',url:'/api/portal/me/profile',headers:{...headers,origin:'https://attacker.example'},payload:profile})).statusCode,403);
        assert.equal((await app.inject({method:'PATCH',url:'/api/portal/me/profile',headers,payload:{...profile,cpf:'123'}})).statusCode,400);
        assert.equal((await app.inject({method:'PATCH',url:'/api/portal/me/profile',headers,payload:{...profile,customerId:other}})).statusCode,400);
        assert.equal((await app.inject({method:'PATCH',url:'/api/portal/me/profile',headers,payload:{...profile,noticeAcknowledged:false}})).statusCode,400);
        const saved=await app.inject({method:'PATCH',url:'/api/portal/me/profile',headers,payload:profile});assert.equal(saved.statusCode,200,saved.body);
        assert.equal((await portal.account(customer)).consent_contact,false);assert.equal((await portal.account(other)).name,'Outra Pessoa');
        assert.equal((await client.query('SELECT count(*)::int AS n FROM customer_privacy_events WHERE customer_id=$1',[customer])).rows[0].n,2);
        await app.inject({method:'PATCH',url:'/api/portal/me/profile',headers,payload:{...profile,consentContact:true}});
        const requestId=randomUUID();
        const charge=await app.inject({method:'POST',url:'/api/portal/me/payments',headers,payload:{planCode:'monthly',requestId}});
        assert.equal(charge.statusCode,200,charge.body);assert.ok(charge.json().checkoutUrl.startsWith('https://www.mercadopago.com.br/'));
        assert.equal((await app.inject({method:'POST',url:'/api/portal/me/payments',headers,payload:{planCode:'monthly',requestId}})).json().checkoutUrl,charge.json().checkoutUrl);
        assert.equal(providerCalls,1);
        assert.equal((await app.inject({method:'POST',url:'/api/portal/me/payments',headers,payload:{planCode:'annual',requestId:randomUUID()}})).statusCode,409);
        const pending=(await app.inject({url:'/api/portal/me',headers:{cookie:cookieHeader}})).json();assert.equal(pending.payments[0].status,'PENDING');assert.ok(pending.payments[0].checkout_url);
        // Only synthetic persistence changes; official reconciliation is covered by the payment-flow verifier.
        await client.query("UPDATE payments SET status='CONFIRMED' WHERE customer_id=$1",[customer]);await client.query("UPDATE charges SET status='paid',paid_at=now() WHERE subscription_id=$1",[subscription]);
        const confirmed=await portal.account(customer);assert.equal(confirmed.payments[0].status,'CONFIRMED');assert.equal(confirmed.payments[0].checkout_url,null);
        const claim=await app.inject({method:'PATCH',url:'/api/portal/me/profile',headers,payload:{...profile,claimedLogin:'outra.conta'}});assert.equal(claim.statusCode,200,claim.body);assert.equal(claim.json().identityReview,true);
        assert.equal((await portal.account(customer)).login,'sintetico.portal');assert.equal((await portal.account(other)).login,'outra.conta');
        await assert.rejects(portal.issueWhatsAppLink({phone,messageId:'paused-link'}),{code:'PORTAL_HUMAN_HOLD'});
        await new PgConversationAgentRepository(scoped).resumeHandoffAutomation(`whatsapp:${phone}`,customer);
        const privacyId=randomUUID();const privacy=await app.inject({method:'POST',url:'/api/portal/me/privacy/requests',headers,payload:{type:'ERASURE',requestId:privacyId}});assert.equal(privacy.statusCode,200,privacy.body);
        assert.equal((await app.inject({method:'POST',url:'/api/portal/me/privacy/requests',headers,payload:{type:'ERASURE',requestId:privacyId}})).json().duplicate,true);
        assert.equal((await client.query('SELECT count(*)::int AS n FROM customer_privacy_requests WHERE customer_id=$1',[customer])).rows[0].n,1);
        assert.ok((await client.query('SELECT id FROM customers WHERE id=$1',[customer])).rows[0]);
        assert.equal((await app.inject({method:'POST',url:'/api/portal/me/privacy/withdraw',headers,payload:{}})).statusCode,200);assert.equal((await portal.account(customer)).consent_contact,false);
        assert.equal((await client.query('SELECT opt_out_at FROM customers WHERE id=$1',[customer])).rows[0].opt_out_at,null);
        const payment=(await client.query('SELECT id,correlation_id,charge_id FROM payments WHERE customer_id=$1',[customer])).rows[0];
        await requestPaymentNotice(client,{subject:{id:payment.id},correlation_id:payment.correlation_id,event_id:randomUUID()});
        const notification=(await client.query("SELECT id FROM notification_requests WHERE customer_id=$1 AND intention='PAYMENT_CONFIRMED'",[customer])).rows[0];
        let syntheticDeliveries=0;
        const send=async()=>{syntheticDeliveries++;return {ok:true,providerId:'synthetic-portal-confirmation'};};
        await deliverCoreNotification({db:scoped,config:testConfig,notificationId:notification.id,send});
        await deliverCoreNotification({db:scoped,config:testConfig,notificationId:notification.id,send});
        assert.equal(syntheticDeliveries,1);
        const reminder=randomUUID();await client.query(`INSERT INTO notification_requests(id,customer_id,channel,intention,context,priority,correlation_id)
          VALUES($1,$2,'WHATSAPP','BILLING_REMINDER',$3::jsonb,'NORMAL',$4)`,[reminder,customer,JSON.stringify({charge_id:payment.charge_id,text:'Synthetic reminder',simulated:false}),randomUUID()]);
        await deliverCoreNotification({db:scoped,config:testConfig,notificationId:reminder,send});assert.equal(syntheticDeliveries,1);
        assert.equal((await client.query('SELECT status FROM notification_requests WHERE id=$1',[reminder])).rows[0].status,'CANCELLED');
        const exported=await app.inject({url:'/api/portal/me/export',headers:{cookie:cookieHeader}});assert.equal(exported.statusCode,200);assert.doesNotMatch(exported.body,/outra-conta|outra\.conta|csrf_token/);
        const expiring=await portal.issueLink({customerId:other,requestKey:'expires'});await client.query('UPDATE customer_portal_links SET expires_at=now()-interval \'1 second\' WHERE customer_id=$1',[other]);
        await assert.rejects(portal.exchangeLink(new URL(expiring.portalUrl).hash.slice(1)),{code:'PORTAL_LINK_INVALID'});
        assert.equal((await app.inject({method:'POST',url:'/api/portal/logout',headers,payload:{}})).statusCode,200);
        assert.equal((await app.inject({url:'/api/portal/me',headers:{cookie:cookieHeader}})).statusCode,401);
        report={verifiedAt:new Date().toISOString(),sha:env.RAILWAY_GIT_COMMIT_SHA||null,realProviderCalls:0,customerMessagesSent:0,realCheckouts:0,
          syntheticCheckouts:providerCalls,singleUseLinks:true,secureSessions:true,csrfProtected:true,crossCustomerAccess:'REJECTED',cpfCollection:false,
          optionalEmail:true,privacyAcknowledgementRecorded:true,optionalConsentWithdrawal:true,transactionalConfirmationAfterOptionalWithdrawal:true,pendingChargeReused:true,officialStatusDisplayed:true,
          claimedLoginDoesNotGrantAccess:true,humanHoldPreserved:true,privacyRequestRegistered:true,privacyRequestDoesNotEraseFinancialRecords:true,logoutRevokesSession:true};
      } finally {await app.close();}
      throw rollback;
    });
  } catch(error) {if(error!==rollback)throw error;}
  finally {globalThis.fetch=originalFetch;}
  assert.deepEqual(await counts(db),before);return {...report,rolledBack:true,databaseCountsUnchanged:true};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){const config=loadConfig(),db=createDb(config.DATABASE_URL,{ssl:config.DATABASE_SSL});try{console.log('GATE_CUSTOMER_PORTAL_VERIFY='+JSON.stringify(await verifyCustomerPortal({db,config})));}finally{await db.close();}}
