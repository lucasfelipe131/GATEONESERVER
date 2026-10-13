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
import {CustomerPortalHelp,scrubPortalHelpText} from '../src/services/customer-portal-help.js';
import {createAIResponse} from '../src/integrations/openai.js';
import {encryptSecret} from '../src/security.js';
import {setSetting} from '../src/db.js';

test('support input scrubs credentials, account values, email, phone, tax numbers, tokens and credential URLs',()=>{
  const values=['synthetic-password','synthetic.username','Lucas Synthetic'];
  const message='Ajuda Samsung Lucas Synthetic synthetic.username synthetic-password email@foreign.test CPF 123.456.789-09 CNPJ 37.192.976/0001-13 telefone (11) 99999-9701 token=foreign-secret https://host.test/get.php?username=person&password=pw';
  const cleaned=scrubPortalHelpText(message,{privateValues:values});
  assert.match(cleaned,/Ajuda Samsung/);
  for(const forbidden of [...values,'email','foreign.test','123.456','37.192','99999','foreign-secret','person','host.test'])
    assert.equal(cleaned.includes(forbidden),false,forbidden);
  assert.equal(scrubPortalHelpText('Ajuda TV ｐｗ senha a',{privateValues:['ｐｗ','a']}).includes('pw'),false);
  assert.equal(scrubPortalHelpText('Ajuda TV ｐｗ senha a',{privateValues:['ｐｗ','a']}).includes('senha a'),false);
  for(const message of ['Ajuda TV senha e foreign-value','Ajuda TV usuário e foreign-login','Ajuda TV token eh foreign-token'])
    assert.match(scrubPortalHelpText(message),/\[dado removido\]/);
  assert.match(scrubPortalHelpText('Ajuda TV senha e foreign-value',{grammar:'unknown'}),/\[dado removido\]/);
});

test('guidance grammar keeps conjunctions while rejecting explicit credential values and all known private values',()=>{
  const options={grammar:'guidance',stripUrls:false};
  for(const instruction of ['A lista contém login e senha.','Preencha usuário e senha com os dados de Meu acesso.',
    'Não compartilhe sua URL, pois contém sua senha e fica visível por tempo limitado.',
    'Copie a senha e o usuário somente no aplicativo oficial.'])assert.equal(scrubPortalHelpText(instruction,options),instruction);
  for(const disclosure of ['Senha: foreign-value','token=foreign-token','Seu login é foreign-login','A senha eh foreign-value',
    'Usuário e senha são foreign-login foreign-value','password is foreign-value','API key: foreign-token',
    'Use http://host.test/get.php?username=foreign-login&password=foreign-value',
    'Bearer foreign-token','sk-unknownsecret123456789'])assert.notEqual(scrubPortalHelpText(disclosure,options),disclosure);
  for(const disclosure of ['Copie synthetic-password.','Use synthetic.username e senha.'])
    assert.notEqual(scrubPortalHelpText(disclosure,{...options,privateValues:['synthetic-password','synthetic.username']}),disclosure);
});

async function fixture({limits=false}={}) {
  const pg=new PGlite({extensions:{pgcrypto}}),adapt=handle=>({query:async(sql,params)=>{
    const r=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await handle.exec(sql)).at(-1):await handle.query(sql,params);
    return{...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};
  }}),db={...adapt(pg),transaction:fn=>pg.transaction(tx=>fn(adapt(tx)))};
  await migrateDatabase(db);
  const config={NODE_ENV:'production',COOKIE_SECRET:'synthetic-portal-ai-cookie-secret',PUBLIC_BASE_URL:'https://portal.example.invalid',
    BITPANEL_BASE_URL:'https://bitpanel.vip',BITPANEL_MODE:'disabled',OPENAI_API_KEY:'sk-synthetic-existing-app-token',
    OPENAI_MODEL:'configured-existing-model',BITPANEL_PASSWORD:'synthetic-provider-password'};
  const one={id:randomUUID(),name:'Lucas Synthetic',email:'lucas@synthetic.test',phone:'5511999999701',login:'synthetic.one',password:'synthetic-one-password'},
    two={id:randomUUID(),name:'Second Synthetic',email:'second@synthetic.test',phone:'5511999999702',login:'synthetic.two',password:'synthetic-two-password'};
  const plans={monthly:randomUUID(),annual:randomUUID()};
  for(const [code,months,price] of [['monthly',1,3000],['annual',12,27000]])
    await db.query('INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,$2,$2,$3,$4)',[plans[code],code,months,price]);
  for(const [index,customer] of [one,two].entries()) {
    await db.query(`INSERT INTO customers(id,name,email,whatsapp_e164,bitpanel_reference,access_password_encrypted,status)
      VALUES($1,$2,$3,$4,$5,$6,'active')`,[customer.id,customer.name,customer.email,customer.phone,customer.login,encryptSecret(customer.password,config.COOKIE_SECRET)]);
    await db.query('INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,status) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(),customer.id,plans[index?'annual':'monthly'],index?'2098-06-05':'2099-01-31',index?'late':'active']);
  }
  await setSetting(db,'customer_help_catalog',{bitpanelSync:{status:'READY'},dns:[
    {name:'Atual',value:'http://current.gatecustomer.com',verifiedAt:new Date(Date.now()-60000).toISOString(),status:'READY',sourceUrl:'https://bitpanel.vip/notices'},
    {name:'Antiga',value:'http://old.gatecustomer.com',verifiedAt:new Date(Date.now()-25*3600000).toISOString(),status:'READY',sourceUrl:'https://bitpanel.vip/notices'}],
    password:'catalog-password-must-not-forward',suggestedApps:[{device:'Samsung',name:'Aplicativo sintético',
      url:'https://smartone-iptv.com/',sourceUrl:'https://smartone-iptv.com/plugin/support_manager/knowledgebase/',
      verifiedAt:new Date(Date.now()-60000).toISOString(),protocols:['xtream'],requiredFields:['username','password','dns'],
      requirements:[`Consulte Meu acesso; informação privada ${one.login} ${one.password}.`,
        `Use https://private-playlist.test/get.php?username=${one.login}&password=${one.password}.`],
      stepsSupport:[`Consulte o guia de instalação ${one.name}.`],playlistUrl:'https://private-playlist.test/get.php'}]});
  const captured=[];let modelReply={reply:'Na TV Samsung, abra Apps e procure o aplicativo indicado em Meu acesso.',sourceIds:['guide-samsung']};
  const complete=(runtime,input)=>createAIResponse(runtime,input,async(url,request)=>{
    captured.push({url,runtime,input,body:JSON.parse(request.body)});
    return{ok:true,json:async()=>({output_text:JSON.stringify(modelReply)})};
  });
  const service=new CustomerPortalHelp({db,config,complete});
  const app=Fastify({logger:false});await app.register(cookie);
  if(limits)await app.register(rateLimit,{max:180,timeWindow:'1 minute'});
  const portal=registerCustomerPortal(app,{db,config,billingAutomation:null,getPaymentOptions:async()=>({methods:[]}),
    requireBotSecret:()=>false,supportAssistant:service});
  const sessions=[];
  for(const customer of [one,two]) {
    const link=await portal.issueLink({customerId:customer.id,requestKey:'synthetic-ai-session'}),session=await portal.exchangeLink(new URL(link.portalUrl).hash.slice(1));
    const cookieHeader=`gate_customer_session=${session.sessionToken}`;
    const me=await app.inject({url:'/api/portal/me',headers:{cookie:cookieHeader}});assert.equal(me.statusCode,200);
    sessions.push({cookie:cookieHeader,origin:config.PUBLIC_BASE_URL,'x-portal-csrf':me.json().csrf_token});
  }
  const snapshot=async()=>({settings:(await db.query('SELECT key,value FROM system_settings ORDER BY key')).rows,
    customers:(await db.query('SELECT id,name,email,access_password_encrypted FROM customers ORDER BY id')).rows,
    subscriptions:(await db.query('SELECT id,expires_on::text,status FROM subscriptions ORDER BY id')).rows,
    counts:(await db.query(`SELECT (SELECT count(*) FROM charges)::int charges,(SELECT count(*) FROM payments)::int payments,
      (SELECT count(*) FROM renewal_jobs)::int renewals,(SELECT count(*) FROM message_logs)::int messages,
      (SELECT count(*) FROM gate_event_outbox)::int outbox,(SELECT count(*) FROM notification_requests)::int notices,
      (SELECT count(*) FROM audit_logs)::int audits`)).rows[0]});
  return{db,config,app,service,one,two,sessions,captured,snapshot,setReply:reply=>{modelReply=reply;},
    close:async()=>{await app.close();await pg.close();}};
}

test('own portal AI requires session/CSRF and only shares scrubbed stateless help context; model failures cannot claim actions or leak credentials',async t=>{
  const originalFetch=globalThis.fetch;let network=0;
  globalThis.fetch=async()=>{network++;throw Error('NO_REAL_NETWORK_IN_PORTAL_AI_TEST');};
  const f=await fixture();const path='/api/portal/me/support/chat';
  try {
    const before=await f.snapshot();
    await t.test('authentication, CSRF, trusted origin and strict small input run before the provider',async()=>{
      assert.equal((await f.app.inject({method:'POST',url:path,payload:{message:'Ajuda Samsung'}})).statusCode,401);
      for(const headers of [{cookie:f.sessions[0].cookie,origin:f.config.PUBLIC_BASE_URL},{...f.sessions[0],origin:'https://foreign.test'}])
        assert.equal((await f.app.inject({method:'POST',url:path,headers,payload:{message:'Ajuda Samsung'}})).statusCode,403);
      for(const payload of [{message:'Ajuda',customerId:f.two.id},{message:'Ajuda',history:[]},{message:'x'.repeat(501)}])
        assert.equal((await f.app.inject({method:'POST',url:path,headers:f.sessions[0],payload})).statusCode,400);
      assert.equal((await f.app.inject({method:'POST',url:path,headers:f.sessions[0],payload:{message:'x'.repeat(5000)}})).statusCode,413);
      assert.equal(f.captured.length,0);
    });
    await t.test('existing model/token, own status, fresh DNS and store=false are used without account identifiers or secrets',async()=>{
      const response=await f.app.inject({method:'POST',url:path,headers:f.sessions[0],payload:{message:`Ajuda Samsung ${f.one.name} ${f.one.login} ${f.one.password} ${f.one.phone} ${f.one.email}`}});
      assert.equal(response.statusCode,200,response.body);assert.equal(response.json().readOnly,true);assert.equal(response.json().sources.length,1);
      assert.match(response.headers['cache-control'],/no-store/);
      const request=f.captured.at(-1),input=JSON.parse(request.body.input);
      assert.equal(request.body.model,'configured-existing-model');assert.equal(request.body.store,false);assert.equal(request.body.max_output_tokens,500);
      assert.equal(request.body.previous_response_id,undefined);assert.equal(request.body.conversation,undefined);assert.equal(request.body.tools,undefined);
      assert.equal(input.context.own.planCode,'monthly');assert.equal(input.context.own.expiresOn,'2099-01-31');
      assert.deepEqual(input.context.dns.map(dns=>dns.value),['http://current.gatecustomer.com']);
      const samsung=input.context.guides.find(guide=>guide.device==='Samsung'),ss=samsung.apps.find(app=>app.name==='SS IPTV'),
        smarters=samsung.apps.find(app=>app.name==='IPTV Smarters Pro / SMARTERS PRO');
      assert.deepEqual(ss.protocols,['m3u']);assert.deepEqual(ss.requiredFields,['playlistUrl']);
      assert.match(ss.requirements.join(' '),/DNS sozinho não é uma lista/);
      assert.match(ss.stepsSupport.join(' '),/Configurações, Conteúdo e Listas externas/);
      assert.match(ss.stepsSupport.join(' '),/nova URL M3U/);assert.equal(ss.availability,'model_check_required');
      assert.deepEqual(smarters.protocols,['xtream','m3u']);assert.deepEqual(smarters.requiredFields,['username','password','dns','playlistUrl']);
      assert.match(smarters.stepsSupport.join(' '),/edição do perfil/);
      assert.match(samsung.apps.find(app=>app.name==='SmartOne IPTV').stepsSupport.join(' '),/usuário e senha com os dados atuais de Meu acesso/);
      assert.match(smarters.requirements.join(' '),/senha de acesso e fica visível por 60 segundos/);
      assert.equal(samsung.apps.some(app=>app.name==='Aplicativo sintético'),false);
      const allowedSources=request.body.text.format.schema.properties.sourceIds.items.enum;
      assert.ok(allowedSources.includes(ss.sourceId));assert.ok(allowedSources.includes(smarters.sourceId));
      const serialized=JSON.stringify(request.body);for(const customer of [f.one,f.two])for(const value of Object.values(customer))assert.equal(serialized.includes(value),false,value);
      for(const secret of ['synthetic-provider-password','catalog-password-must-not-forward','old.gatecustomer.com','private-playlist.test'])assert.equal(serialized.includes(secret),false);
      assert.deepEqual(Object.keys(request.runtime).sort(),['OPENAI_API_KEY','OPENAI_MODEL']);
      f.setReply({reply:'No SS IPTV, abra Configurações, Conteúdo e Listas externas. Para trocar a URL, obtenha a nova lista M3U com a equipe e teste antes de remover a anterior.',sourceIds:[ss.sourceId]});
      const appHelp=await f.app.inject({method:'POST',url:path,headers:f.sessions[0],payload:{message:'Como mudar a URL no SS IPTV Samsung?'}});
      assert.equal(appHelp.statusCode,200,appHelp.body);
      assert.equal(appHelp.json().sources[0].url,'https://ss-iptv.com/en/users/documents/how-to-upload-playlist');
      await f.app.inject({method:'POST',url:path,headers:f.sessions[1],payload:{message:'Qual meu plano de assinatura?'}});
      assert.equal(JSON.parse(f.captured.at(-1).body.input).context.own.planCode,'annual');
      for(const request of f.captured)for(const customer of [f.one,f.two])for(const value of Object.values(customer))
        assert.equal(JSON.stringify(request.body).includes(value),false,value);
      assert.deepEqual(await f.snapshot(),before);
    });
    await t.test('normal manual instructions about login and password reach the client unchanged',async()=>{
      for(const reply of ['A lista contém login e senha. Copie a URL pelo botão protegido de Meu acesso e use somente no aplicativo oficial.',
        'No SS IPTV, abra Configurações, Conteúdo e Listas externas. Não compartilhe sua URL, pois contém sua senha e fica visível por tempo limitado.',
        'No aplicativo, preencha usuário e senha com os dados atuais de Meu acesso.']){
        f.setReply({reply,sourceIds:['guide-samsung']});
        const response=await f.app.inject({method:'POST',url:path,headers:f.sessions[0],payload:{message:'Como trocar a URL no SS IPTV Samsung?'}});
        assert.equal(response.statusCode,200,response.body);assert.equal(response.json().reply,reply);
        assert.equal(response.json().readOnly,true);assert.equal(response.json().sources.length,1);
      }
      assert.deepEqual(await f.snapshot(),before);
    });
    await t.test('plain verified menu paths normalize their separators without allowing HTML, attributes or unrelated comparisons',async()=>{
      for(const [reply,expected] of [
        ['No SS IPTV, abra Configurações > Conteúdo > Listas externas e confira a lista.',
          'No SS IPTV, abra Configurações → Conteúdo → Listas externas e confira a lista.'],
        ['Na TV Samsung, abra Home > Apps. Depois, consulte o guia.',
          'Na TV Samsung, abra Home → Apps. Depois, consulte o guia.'],
        ['Abra Sistema > Atualização do sistema > Verificar agora.',
          'Abra Sistema → Atualização do sistema → Verificar agora.']
      ]) {
        f.setReply({reply,sourceIds:['guide-samsung']});
        const response=await f.app.inject({method:'POST',url:path,headers:f.sessions[0],payload:{message:'Como configurar o SS IPTV na TV Samsung?'}});
        assert.equal(response.statusCode,200,response.body);assert.equal(response.json().reply,expected);
        assert.equal(response.json().readOnly,true);assert.equal(response.json().sources.length,1);
      }
      assert.match(f.captured.at(-1).input.instructions,/vírgulas ou a seta →/);
      for(const reply of ['Configurações > Conteúdo <script>alert(1)</script>',
        '<b>Configurações > Conteúdo</b>','Configurações > Conteúdo <img src=x onerror=alert(1)>',
        'Configurações > Conteúdo onerror="alert(1)"','Configurações > Conteúdo href="javascript:alert(1)"',
        'Configurações > Conteúdo &lt;script&gt;alert(1)&lt;/script&gt;',
        'Configurações > Conteúdo javascript:alert(1)','Configurações > Conteúdo data:text/html,script',
        'Configurações > Conteúdo > Opção desconhecida','O saldo é 12 > 9.',
        `Configurações > Conteúdo. Use ${f.one.password}.`,
        'Configurações > Conteúdo. Abra https://foreign.test/login.',
        'Configurações > Conteúdo. Seu pagamento foi aprovado.',
        'Configurações > Conteúdo. O plano custa R$ 99,00.']) {
        f.setReply({reply,sourceIds:['guide-samsung']});
        const response=await f.app.inject({method:'POST',url:path,headers:f.sessions[0],payload:{message:'Como configurar o SS IPTV na TV Samsung?'}});
        assert.equal(response.statusCode,200,response.body);assert.match(response.json().reply,/Não consegui conferir/);
        assert.deepEqual(response.json().sources,[]);assert.equal(response.body.includes(f.one.password),false);
      }
      assert.deepEqual(await f.snapshot(),before);assert.equal(network,0);
    });
    await t.test('invented actuation, payments, foreign URLs, prices and secrets are replaced by safe guidance',async()=>{
      for(const reply of ['Renovei sua assinatura.','Seu pagamento foi aprovado.','Vou ativar seu plano.',`Use ${f.one.password}.`,
        `Use ${f.one.login}.`,`O usuário é ${f.two.login}.`,`A senha é ${f.two.password}.`,
        `Copie o usuário e ${f.one.password}.`,`A senha e ${f.one.password} devem ser usados na TV.`,
        'Sua senha: foreign-value','Seu login eh foreign-login','Usuário e senha são foreign-login foreign-password',
        'token=foreign-token','Bearer foreign-token','sk-unknownsecret123456789',
        'Use http://current.gatecustomer.com/get.php?username=foreign-login&password=foreign-value',
        'Abra https://foreign.test/login.','Use o DNS http://old.gatecustomer.com.','O plano custa R$ 99,00.']) {
        f.setReply({reply,sourceIds:[]});
        const response=await f.app.inject({method:'POST',url:path,headers:f.sessions[0],payload:{message:'Ajuda com minha assinatura Samsung'}});
        assert.equal(response.statusCode,200,response.body);assert.match(response.json().reply,/Não consegui conferir/);
        assert.equal(response.body.includes(f.one.password),false);
      }
      const prior=f.captured.length,operation=await f.app.inject({method:'POST',url:path,headers:f.sessions[0],payload:{message:'Renove meu plano anual'}});
      assert.match(operation.json().reply,/aba Pagamentos/);assert.equal(f.captured.length,prior);
      assert.deepEqual(await f.snapshot(),before);assert.equal(network,0);
    });
    await t.test('a deadline or overlapping request produces only a fixed public error',async()=>{
      let entered,release;const began=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
      const concurrent=new CustomerPortalHelp({db:f.db,config:f.config,complete:async()=>{entered();await blocked;return{text:JSON.stringify({reply:'Abra Apps na TV Samsung.',sourceIds:[]})};}});
      const pending=concurrent.ask(f.one.id,{message:'Ajuda Samsung'});await began;
      await assert.rejects(concurrent.ask(f.one.id,{message:'Ajuda Samsung'}),{code:'PORTAL_AI_BUSY'});release();await pending;
      const timed=new CustomerPortalHelp({db:f.db,config:f.config,timeoutMs:50,complete:async()=>new Promise(()=>{})});
      await assert.rejects(timed.ask(f.one.id,{message:'Ajuda Samsung'}),{code:'PORTAL_AI_TIMEOUT'});
      const failed=new CustomerPortalHelp({db:f.db,config:f.config,complete:async()=>{throw Error(`private ${f.one.password}`);}});
      await assert.rejects(failed.ask(f.one.id,{message:'Ajuda Samsung'}),{code:'PORTAL_AI_UNAVAILABLE'});
      assert.deepEqual(await f.snapshot(),before);
    });
  }finally{await f.close();globalThis.fetch=originalFetch;}
});

test('the authenticated support route bounds provider usage to ten requests per hour per session',async()=>{
  const f=await fixture({limits:true});try{
    for(let index=0;index<10;index++)assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/support/chat',headers:f.sessions[0],payload:{message:'Ajuda Samsung'}})).statusCode,200);
    assert.equal((await f.app.inject({method:'POST',url:'/api/portal/me/support/chat',headers:f.sessions[0],payload:{message:'Ajuda Samsung'}})).statusCode,429);
    assert.equal(f.captured.length,10);
  }finally{await f.close();}
});
