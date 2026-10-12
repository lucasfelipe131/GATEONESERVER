// Entirely local synthetic preview; no production database or provider is loaded.
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {setSetting} from '../src/db.js';
import {registerCustomerPortal} from '../src/customer-portal-routes.js';
import {CustomerAccessSync} from '../src/services/customer-access-sync.js';
import {PRIVACY_NOTICE_VERSION} from '../src/services/customer-portal.js';
// Provider requests are forbidden in this in-memory demonstration.
globalThis.fetch=async()=>{throw new Error('PROVIDER_NETWORK_DISABLED_IN_SYNTHETIC_PREVIEW');};
const config={NODE_ENV:'test',COOKIE_SECRET:'preview-local-synthetic',PUBLIC_BASE_URL:'',PUBLIC_WHATSAPP_NUMBER:'5511999999700',BITPANEL_BASE_URL:'https://bitpanel.vip',BITPANEL_MODE:'disabled'};
const pg=new PGlite({extensions:{pgcrypto}}),adapter=pg=>({query:async(sql,params)=>{const r=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await pg.exec(sql)).at(-1):await pg.query(sql,params);return{...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};}});
const db={...adapter(pg),transaction:fn=>pg.transaction(tx=>fn(adapter(tx)))};
await migrateDatabase(db);await setSetting(db,'privacy_controller_name','Gate One Pro · demonstração');await setSetting(db,'privacy_contact','privacidade@example.invalid');
const customer=randomUUID(),subscription=randomUUID();
await db.query(`INSERT INTO plans(code,name,duration_months,price_cents,sort_order) VALUES('monthly','Mensal',1,3000,1),('quarterly','Trimestral',3,8500,2),('semiannual','Semestral',6,15000,3),('annual','Anual',12,27000,4)`);
await db.query(`INSERT INTO customers(id,name,email,whatsapp_e164,bitpanel_reference,bitpanel_owner,status,consent_contact,automation_eligible) VALUES($1,'Ana Demonstração','ana@example.invalid','5511999999701','ana.demo','Gate One Pro Server','active',false,true)`,[customer]);
await db.query(`INSERT INTO subscriptions(id,customer_id,plan_id,starts_on,expires_on,status,bitpanel_list_id) SELECT $1,$2,id,CURRENT_DATE,CURRENT_DATE+20,'active','9999001' FROM plans WHERE code='monthly'`,[subscription,customer]);
await db.query(`INSERT INTO charges(subscription_id,plan_id,stage,status,amount_cents,due_on,idempotency_key,message_text,paid_at) SELECT $1,id,'manual','paid',3000,CURRENT_DATE,'preview-paid','Histórico sintético de demonstração',now() FROM plans WHERE code='monthly'`,[subscription]);
const access=new CustomerAccessSync({db,config}),binding=await access.binding(db,customer);
await access.saveSuccess(binding,{listId:'9999001',username:'ana.demo',owner:'Gate One Pro Server',password:'DEMONSTRACAO-NAO-REAL',sourceUrl:'https://bitpanel.vip/list/view/9999001'},config);
const verifiedAt=new Date().toISOString();
await setSetting(db,'customer_help_catalog',{
  suggestedApps:['Samsung','LG'].map(device=>({device,name:'SmartOne IPTV',url:'https://smartone-iptv.com/',sourceUrl:'https://smartone-iptv.com/plugin/support_manager/knowledgebase/',verifiedAt})),
  // This provider DNS was verified separately; account credentials are always synthetic.
  dns:[{name:'DNS do fornecedor — conta de demonstração',value:'http://auth.urlcld.com',status:'READY',sourceUrl:'https://bitpanel.vip/notices',verifiedAt}],
  bitpanelSync:{status:'READY',verifiedAt},
  posts:[{source:'bitpanel',category:'notices',title:'Demonstração · Acompanhe os avisos por aqui',content:'Esta é uma publicação fictícia para visualizar a nova área. Os comunicados do serviço aparecem com origem e data de conferência.',url:'https://bitpanel.vip/notices',publishedAt:verifiedAt,verifiedAt},
    {source:'bitpanel',category:'news',title:'Demonstração · Sua TV, seus guias',content:'Esta é uma novidade fictícia de demonstração. Escolha Samsung, LG ou Roku na aba Instalar na TV para consultar as orientações disponíveis.',url:'https://bitpanel.vip/news',publishedAt:verifiedAt,verifiedAt}],
  telegram:{channelUrl:'https://t.me/+OkM9So6d9npjODRh',verifiedAt,sourceUrl:'https://bitpanel.vip/'}
});
const app=Fastify({logger:false});await app.register(cookie);await app.register(staticFiles,{root:join(dirname(fileURLToPath(import.meta.url)),'..','public')});
const portal=registerCustomerPortal(app,{db,config,billingAutomation:null,supportAssistant:{ask:async()=>({reply:'Demonstração: no SS IPTV, abra Configurações, Conteúdo e Listas externas. Adicione a URL M3U da sua própria conta e salve. Para trocar a URL, adicione uma nova lista e teste antes de remover a anterior.',readOnly:true,sources:[{title:'Guia oficial SS IPTV',url:'https://ss-iptv.com/en/users/documents/how-to-upload-playlist'}]})},getPaymentOptions:async()=>({methods:['Pix','Cartão de crédito','Boleto']}),requireBotSecret:(_request,reply)=>{reply.code(401).send({error:'Disabled in preview'});return false;}});
await portal.saveProfile(customer,{name:'Ana Demonstração',email:'ana@example.invalid',claimedLogin:'',noticeAcknowledged:true,noticeVersion:PRIVACY_NOTICE_VERSION,consentContact:false});
const address=await app.listen({host:'127.0.0.1',port:0});config.PUBLIC_BASE_URL=address;
console.log('SYNTHETIC_PORTAL_PREVIEW='+JSON.stringify({url:(await portal.issueLink({customerId:customer,requestKey:'preview'})).portalUrl,address,realCharges:0,realMessages:0,providerNetwork:'disabled',credentials:'synthetic-only',payments:'synthetic-only',dns:'provider-source-reviewed-separately'}));
const stop=async()=>{await app.close();await pg.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
