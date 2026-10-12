import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {registerCustomerPortal} from '../src/customer-portal-routes.js';
import {encryptSecret} from '../src/security.js';
import {setSetting} from '../src/db.js';

async function fixture({limits=false}={}) {
  const pg=new PGlite({extensions:{pgcrypto}});
  const adapter=handle=>({query:async(sql,params)=>{const result=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await handle.exec(sql)).at(-1):await handle.query(sql,params);return{...result,rowCount:result.rowCount??result.affectedRows??result.rows.length};}});
  const db={...adapter(pg),transaction:fn=>pg.transaction(tx=>fn(adapter(tx)))};
  await migrateDatabase(db);
  const config={NODE_ENV:'production',COOKIE_SECRET:'synthetic-customer-portal-route-secret',PUBLIC_BASE_URL:'https://portal.example.invalid',
    PUBLIC_WHATSAPP_NUMBER:'5511999999700',BITPANEL_BASE_URL:'https://bitpanel.vip',BITPANEL_MODE:'disabled'};
  const customers=[{id:randomUUID(),phone:'5511999999701',username:'synthetic.one',password:'synthetic-one-secret',listId:'12345'},
    {id:randomUUID(),phone:'5511999999702',username:'synthetic.two',password:'synthetic-two-secret',listId:'56789'}];
  const plan=randomUUID();
  await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Mensal',1,3000)",[plan]);
  for(const customer of customers){
    const subscription=randomUUID();
    await db.query(`INSERT INTO customers(id,name,whatsapp_e164,bitpanel_reference,bitpanel_owner,access_password_encrypted,status)
      VALUES($1,'Cliente sintético',$2,$3,'Gate One Pro Server',$4,'active')`,[customer.id,customer.phone,customer.username,encryptSecret(customer.password,config.COOKIE_SECRET)]);
    await db.query("INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,bitpanel_list_id) VALUES($1,$2,$3,'2026-12-31',$4)",[subscription,customer.id,plan,customer.listId]);
    await db.query(`INSERT INTO customer_access_sync(customer_id,subscription_id,list_id,username,owner,verified_whatsapp_e164,source_url,verified_at,status)
      VALUES($1,$2,$3,$4,'Gate One Pro Server',$5,$6,now(),'READY')`,[customer.id,subscription,customer.listId,customer.username,customer.phone,`https://bitpanel.vip/list/view/${customer.listId}`]);
  }
  await setSetting(db,'privacy_controller_name','Responsável sintético');await setSetting(db,'privacy_contact','privacy@example.invalid');
  const app=Fastify({logger:false});await app.register(cookie);if(limits)await app.register(rateLimit,{max:180,timeWindow:'1 minute'});
  const portal=registerCustomerPortal(app,{db,config,billingAutomation:null,getPaymentOptions:async()=>({methods:[]}),requireBotSecret:()=>false});
  const sessions=[];
  for(const customer of customers){
    const link=await portal.issueLink({customerId:customer.id,requestKey:'route-fixture'});
    const login=await app.inject({method:'POST',url:'/api/portal/session',headers:{origin:config.PUBLIC_BASE_URL},payload:{token:new URL(link.portalUrl).hash.slice(1)}});
    assert.equal(login.statusCode,200,login.body);
    const cookieHeader=login.headers['set-cookie'].split(';')[0];
    const me=await app.inject({url:'/api/portal/me',headers:{cookie:cookieHeader}});assert.equal(me.statusCode,200,me.body);
    sessions.push({cookie:cookieHeader,origin:config.PUBLIC_BASE_URL,'x-portal-csrf':me.json().csrf_token});
  }
  const financial=async()=>{
    const row=(await db.query(`SELECT (SELECT count(*) FROM charges)::int AS charges,(SELECT count(*) FROM payments)::int AS payments,
      (SELECT count(*) FROM renewal_jobs)::int AS renewals,(SELECT count(*) FROM message_logs)::int AS messages,
      (SELECT count(*) FROM notification_requests)::int AS notices,(SELECT count(*) FROM gate_event_outbox)::int AS outbox`)).rows[0];
    return{...row,dates:(await db.query('SELECT id,expires_on::text FROM subscriptions ORDER BY id')).rows};
  };
  return{app,db,pg,config,customers,sessions,financial,close:async()=>{await app.close();await pg.close();}};
}

test('portal access routes require the owner session and CSRF, reveal only verified own credentials and audit without secrets',async()=>{
  const originalFetch=globalThis.fetch;let network=0;globalThis.fetch=async()=>{network++;throw new Error('NO_PROVIDER_NETWORK_IN_PORTAL_ACCESS_ROUTES');};
  const f=await fixture();
  try {
    const [one,two]=f.customers,[headers,otherHeaders]=f.sessions,before=await f.financial();
    for(const path of ['/api/portal/me/access','/api/portal/me/help'])assert.equal((await f.app.inject({url:path})).statusCode,401);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',payload:{}})).statusCode,401);
    const metadata=await f.app.inject({url:`/api/portal/me/access?customerId=${two.id}`,headers});
    assert.equal(metadata.statusCode,200,metadata.body);assert.equal(metadata.json().username,one.username);assert.equal(metadata.json().passwordAvailable,true);
    assert.equal(metadata.json().status,'READY');assert.match(metadata.headers['cache-control'],/no-store/);assert.equal(metadata.headers['referrer-policy'],'no-referrer');
    assert.deepEqual(Object.keys(metadata.json()).sort(),['expiresAt','passwordAvailable','source','status','syncedAt','username']);
    assert.equal(metadata.body.includes(one.password),false);assert.equal(metadata.body.includes(two.username),false);assert.equal(metadata.body.includes(two.password),false);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers:{cookie:headers.cookie},payload:{}})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers:{...headers,origin:'https://attacker.example'},payload:{}})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers:{...headers,'x-portal-csrf':otherHeaders['x-portal-csrf']},payload:{}})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers,payload:{customerId:two.id}})).statusCode,400);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers,payload:{username:two.username}})).statusCode,400);
    assert.equal((await f.app.inject({method:'GET',url:'/api/portal/me/access/reveal',headers})).statusCode,404);
    const revealed=await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers,payload:{}});
    assert.equal(revealed.statusCode,200,revealed.body);assert.deepEqual(revealed.json(),{username:one.username,password:one.password,expiresInSeconds:60,playlistUrl:null});
    assert.match(revealed.headers['cache-control'],/no-store/);assert.equal(revealed.body.includes(two.password),false);
    const other=await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers:otherHeaders,payload:{}});assert.equal(other.json().password,two.password);
    const audit=(await f.db.query("SELECT actor_type,actor_id,action,entity_id,before_data,after_data FROM audit_logs WHERE action='customer.access_revealed' ORDER BY id")).rows;
    assert.equal(audit.length,2);assert.equal(audit[0].actor_type,'customer');assert.equal(audit[0].actor_id,one.id);assert.equal(audit[0].entity_id,one.id);
    assert.deepEqual(audit[0].after_data,{expiresInSeconds:60});assert.equal(audit[0].before_data,null);
    assert.equal(JSON.stringify(audit).includes(one.password),false);assert.equal(JSON.stringify(audit).includes(two.password),false);assert.equal(JSON.stringify(audit).includes('access_password_encrypted'),false);
    for(const path of ['/api/portal/me','/api/portal/me/export','/api/portal/me/help']){
      const response=await f.app.inject({url:path,headers});assert.equal(response.statusCode,200,response.body);
      assert.equal(response.body.includes(one.password),false);assert.equal(response.body.includes(two.password),false);assert.equal(response.body.includes('access_password_encrypted'),false);
    }
    await f.db.query("UPDATE customers SET whatsapp_e164='5511999999711' WHERE id=$1",[one.id]);
    assert.equal((await f.app.inject({url:'/api/portal/me/access',headers})).statusCode,401);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers,payload:{}})).statusCode,401);
    assert.deepEqual(await f.financial(),before);assert.equal(network,0);
  }finally{await f.close();globalThis.fetch=originalFetch;}
});

test('access reveal is limited to six per hour per session and another customer on the same connection is independent',async()=>{
  const f=await fixture({limits:true});
  try {
    const before=await f.financial();
    for(let i=0;i<6;i++){const response=await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers:f.sessions[0],payload:{}});assert.equal(response.statusCode,200,response.body);}
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers:f.sessions[0],payload:{}})).statusCode,429);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers:f.sessions[1],payload:{}})).statusCode,200);
    assert.equal((await f.app.inject({url:'/api/portal/me/access',headers:f.sessions[0]})).statusCode,200);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='customer.access_revealed'")).rows[0].n,7);
    assert.deepEqual(await f.financial(),before);
  }finally{await f.close();}
});

test('the private M3U reveal uses only the authenticated own credentials and a fresh unambiguous provider DNS',async()=>{
  const originalFetch=globalThis.fetch;let network=0;globalThis.fetch=async()=>{network++;throw Error('NO_NETWORK_IN_PRIVATE_PLAYLIST_REVEAL');};
  const f=await fixture();try{
    const [one,two]=f.customers,[headers,otherHeaders]=f.sessions,before=await f.financial(),path='/api/portal/me/access/reveal';
    const dns={name:'DNS atual sintético',value:'http://current.gatecustomer.com',status:'READY',
      verifiedAt:new Date(Date.now()-60000).toISOString(),sourceUrl:'https://bitpanel.vip/notices'};
    const catalog=items=>setSetting(f.db,'customer_help_catalog',{bitpanelSync:{status:'READY'},dns:items});
    await catalog([dns]);
    assert.equal((await f.app.inject({method:'POST',url:path,payload:{}})).statusCode,401);
    assert.equal((await f.app.inject({method:'POST',url:path,headers:{cookie:headers.cookie,origin:headers.origin},payload:{}})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:path,headers,payload:{customerId:two.id}})).statusCode,400);
    const revealed=await f.app.inject({method:'POST',url:`${path}?customerId=${two.id}`,headers,payload:{}});
    assert.equal(revealed.statusCode,200,revealed.body);assert.match(revealed.headers['cache-control'],/no-store/);
    assert.equal(revealed.headers['referrer-policy'],'no-referrer');assert.equal(revealed.json().expiresInSeconds,60);
    const ownUrl=new URL(revealed.json().playlistUrl);assert.equal(ownUrl.origin,dns.value);assert.equal(ownUrl.pathname,'/get.php');
    assert.deepEqual(Object.fromEntries(ownUrl.searchParams),{username:one.username,password:one.password,type:'m3u_plus',output:'ts'});
    assert.equal(revealed.body.includes(two.username),false);assert.equal(revealed.body.includes(two.password),false);
    const other=await f.app.inject({method:'POST',url:path,headers:otherHeaders,payload:{}}),otherUrl=new URL(other.json().playlistUrl);
    assert.equal(otherUrl.searchParams.get('username'),two.username);assert.equal(otherUrl.searchParams.get('password'),two.password);
    for(const safePath of ['/api/portal/me/access','/api/portal/me/help','/api/portal/me','/api/portal/me/export']){
      const response=await f.app.inject({url:safePath,headers});assert.equal(response.statusCode,200,response.body);
      for(const privateValue of [one.password,two.password,'/get.php','playlistUrl":'])assert.equal(response.body.includes(privateValue),false);
    }
    for(const unavailable of [[{...dns,verifiedAt:new Date(Date.now()-25*3600000).toISOString()}],
      [{...dns,sourceUrl:'https://bitpanel.vip/'}],[{...dns,value:'current.gatecustomer.com'}],
      [dns,{...dns,value:'http://conflicting.gatecustomer.com'}]]){
      await catalog(unavailable);const response=await f.app.inject({method:'POST',url:path,headers,payload:{}});
      assert.equal(response.statusCode,200,response.body);assert.equal(response.json().playlistUrl,null);
    }
    await catalog([dns]);await f.db.query("UPDATE customer_access_sync SET verified_at=now()-interval '25 hours' WHERE customer_id=$1",[one.id]);
    const stale=await f.app.inject({method:'POST',url:path,headers,payload:{}});assert.equal(stale.statusCode,409);assert.equal(stale.body.includes(one.password),false);
    const audits=(await f.db.query("SELECT before_data,after_data FROM audit_logs WHERE action='customer.access_revealed'")).rows;
    for(const privateValue of [one.username,two.username,one.password,two.password,'/get.php'])assert.equal(JSON.stringify(audits).includes(privateValue),false);
    assert.deepEqual(await f.financial(),before);assert.equal(network,0);
  }finally{await f.close();globalThis.fetch=originalFetch;}
});

test('stale or unverified access returns a safe update request without revealing legacy passwords',async()=>{
  const f=await fixture();
  try {
    await f.db.query("UPDATE customer_access_sync SET verified_at=now()-interval '25 hours' WHERE customer_id=$1",[f.customers[0].id]);
    const metadata=await f.app.inject({url:'/api/portal/me/access',headers:f.sessions[0]});assert.equal(metadata.json().status,'STALE');assert.equal(metadata.json().passwordAvailable,false);
    const stale=await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers:f.sessions[0],payload:{}});assert.equal(stale.statusCode,409);assert.match(stale.json().error,/precisa ser conferido/);assert.equal(stale.body.includes(f.customers[0].password),false);
    await f.db.query('DELETE FROM customer_access_sync WHERE customer_id=$1',[f.customers[1].id]);
    const unverified=await f.app.inject({url:'/api/portal/me/access',headers:f.sessions[1]});assert.equal(unverified.json().passwordAvailable,false);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/access/reveal',headers:f.sessions[1],payload:{}})).statusCode,409);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='customer.access_revealed'")).rows[0].n,0);
  }finally{await f.close();}
});

test('authenticated help joins verified catalog and existing Telegram posts while filtering credentials and invalid sources',async()=>{
  const f=await fixture();
  try {
    const before=await f.financial(),verifiedAt=new Date(Date.now()-60000).toISOString();
    await setSetting(f.db,'customer_help_catalog',{suggestedApps:[{device:'Samsung',name:'SmartOne IPTV',url:'https://smartone-iptv.com/',sourceUrl:'https://smartone-iptv.com/plugin/support_manager/knowledgebase/',verifiedAt}],
      dns:[{name:'Servidor sintético',value:'stream.gatecustomer.com:443',status:'READY',sourceUrl:'https://bitpanel.vip/',verifiedAt}],password:'catalog-secret-must-not-leak'});
    await setSetting(f.db,'telegram_content_sync',{previewUrl:'https://t.me/s/canalgate',lastSuccessAt:verifiedAt});
    for(const [id,content] of [['100','Aviso: manutenção programada.'],['101','Novidade no serviço.'],['102','Senha: synthetic-two-secret']])await f.db.query(`INSERT INTO content_updates(source,source_post_id,content,url,published_at) VALUES('telegram',$1,$2,$3,$4)`,[`canalgate/${id}`,content,`https://t.me/canalgate/${id}`,verifiedAt]);
    const response=await f.app.inject({url:'/api/portal/me/help',headers:f.sessions[0]});assert.equal(response.statusCode,200,response.body);assert.match(response.headers['cache-control'],/no-store/);
    const help=response.json();assert.deepEqual(help.guides.map(guide=>guide.device),['Samsung','LG','Roku']);assert.ok(help.guides[0].apps.some(app=>app.name==='SmartOne IPTV'));assert.equal(help.dns[0].status,'current');
    assert.equal(help.telegram.channelUrl,'https://t.me/canalgate');assert.equal(help.telegram.posts.length,2);assert.deepEqual(help.telegram.posts.map(post=>post.category).sort(),['news','notices']);
    assert.equal(response.body.includes('catalog-secret-must-not-leak'),false);assert.equal(response.body.includes('synthetic-two-secret'),false);assert.equal(response.body.includes(f.customers[1].username),false);
    assert.deepEqual(await f.financial(),before);
  }finally{await f.close();}
});
