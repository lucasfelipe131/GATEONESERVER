import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import vm from 'node:vm';

const html=await readFile(new URL('../public/portal.html',import.meta.url),'utf8');
const script=await readFile(new URL('../public/portal.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
const baseAccount=()=>({name:'Ana Cliente',email:'',whatsapp_e164:'5511999999701',login:'ana-servico',status:'active',plan_code:'monthly',plan_name:'Mensal',price_cents:3000,expires_on:'2026-11-12',payment_methods:['Pix','Cartão de crédito','Boleto'],payments:[],plans:[{code:'monthly',name:'Mensal',price_cents:3000,duration_months:1}],privacy:{ready:true,controller:'Responsável Sintético',contact:'privacy@example.invalid',version:'2026-10-12.1',acknowledgedAt:'2026-10-12T12:00:00Z',requests:[]},whatsapp_url:'https://wa.me/5511999999700',consent_contact:true,csrf_token:'synthetic-csrf'});
const baseAccess=()=>({username:'ana-servico',passwordAvailable:true,source:'bitpanel',syncedAt:'2026-10-12T12:00:00Z',status:'current',expiresAt:'2026-11-12'});
const baseHelp=()=>({updatedAt:null,guides:[],dns:[],telegram:{channelUrl:null,lastSuccessAt:null,status:'unavailable',posts:[]}});

async function portal({url='https://portal.example.invalid/cliente',account=baseAccount(),access=baseAccess(),help=baseHelp(),respond}={}) {
  const dom=new JSDOM(html,{url,runScripts:'outside-only',pretendToBeVisual:true}),{window}=dom;
  const requests=[],timers=new Map(),copied=[];let nextTimer=1;
  window.crypto.randomUUID=randomUUID;window.setInterval=()=>1;window.clearInterval=()=>{};
  window.setTimeout=(callback,delay)=>{const id=nextTimer++;timers.set(id,{callback,delay});return id;};window.clearTimeout=id=>timers.delete(id);
  window.navigator.clipboard={writeText:async value=>{copied.push(value);}};
  window.fetch=async(path,options={})=>{
    requests.push({url:path,...options});
    let body=account,status=200;
    if(path.endsWith('/session')||path.endsWith('/profile')||path.endsWith('/logout'))body={ok:true};
    if(path.endsWith('/privacy'))body={whatsapp_url:account.whatsapp_url};
    if(path.endsWith('/me/access'))body=access;
    if(path.endsWith('/me/help'))body=help;
    if(path.endsWith('/me/access/reveal'))body={username:access.username,password:'senha-sintetica',expiresInSeconds:60};
    if(path.endsWith('/payments')){body={error:'Cobrança de teste bloqueada.'};status=409;}
    if(respond){const result=await respond(path,options);if(result){body=result.body;status=result.status??200;}}
    return{ok:status<400,status,json:async()=>structuredClone(body)};
  };
  vm.runInContext(script,dom.getInternalVMContext());await settle();
  return{dom,window,requests,timers,copied,$:selector=>window.document.querySelector(selector),close:()=>dom.window.close()};
}

test('customer portal renders untrusted fields safely, keeps notices optional, and only creates payment on explicit action',async()=>{
  const account=baseAccount();account.name='<img onerror=alert(1)> Ana';account.login='<script>unsafe</script>';account.privacy.acknowledgedAt=null;
  const p=await portal({url:'https://portal.example.invalid/cliente#'+'a'.repeat(43),account,access:{...baseAccess(),username:account.login}}),{$,requests,window}=p;
  try {
    assert.equal(window.location.hash,'');assert.equal(window.location.pathname,'/cliente');assert.equal($('#account').hidden,false);
    assert.ok($('#login').textContent.includes('<script>'));assert.equal($('#login script'),null);assert.equal($('#greeting img'),null);
    assert.equal($('#profile').hidden,false);assert.equal($('#profileForm input[name="cpf"]'),null);
    assert.equal($('#profileForm input[name="consentContact"]').checked,false);assert.equal($('#profileForm input[name="consentContact"]').required,false);
    assert.equal($('#profileForm input[name="noticeAcknowledged"]').checked,false);assert.equal($('#profileForm input[name="noticeAcknowledged"]').required,true);
    assert.equal(requests.filter(r=>r.url.endsWith('/payments')).length,0);
    $('[data-tab="payments"]').click();$('[data-plan="monthly"]').click();assert.match($('#selectedPlan').textContent,/30,00/);
    assert.equal(requests.filter(r=>r.url.endsWith('/payments')).length,0);
    $('#createPayment').click();await settle();
    const payment=requests.find(r=>r.url.endsWith('/payments'));assert.equal(payment.method,'POST');assert.equal(payment.headers['X-Portal-CSRF'],'synthetic-csrf');assert.deepEqual(Object.keys(JSON.parse(payment.body)).sort(),['planCode','requestId']);
    const form=$('#profileForm');form.elements.name.value='Ana Cliente';form.elements.claimedLogin.value='';form.elements.noticeAcknowledged.checked=true;
    form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
    const profile=JSON.parse(requests.find(r=>r.url.endsWith('/profile')).body);assert.equal(profile.email,'');assert.equal(profile.consentContact,false);assert.equal(profile.noticeAcknowledged,true);assert.equal(profile.cpf,undefined);
  }finally{p.close();}
});

test('service password is fetched only on explicit action and erased on timeout, tab change, hidden page and logout',async()=>{
  const p=await portal(),{$,requests,window,timers}=p;
  try {
    assert.equal(requests.some(r=>r.url.endsWith('/reveal')),false);assert.equal($('#accessPassword').textContent,'••••••••');
    assert.equal($('#revealPassword').disabled,false);$('#revealPassword').click();await settle();
    const reveal=requests.find(r=>r.url.endsWith('/reveal'));assert.equal(reveal.method,'POST');assert.equal(reveal.headers['X-Portal-CSRF'],'synthetic-csrf');assert.equal(reveal.body,'{}');
    assert.equal($('#accessPassword').textContent,'senha-sintetica');assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);
    const timer=[...timers.values()].find(t=>t.delay===60000);assert.ok(timer);timer.callback();assert.equal($('#accessPassword').textContent,'••••••••');
    $('#revealPassword').click();await settle();$('[data-tab="guides"]').click();assert.equal($('#accessPassword').textContent,'••••••••');
    $('[data-tab="overview"]').click();$('#revealPassword').click();await settle();window.document.dispatchEvent(new window.Event('visibilitychange'));assert.equal($('#accessPassword').textContent,'••••••••');
    $('#revealPassword').click();await settle();$('#logout').click();assert.equal($('#accessPassword').textContent,'••••••••');await settle();assert.equal($('#account').hidden,true);
  }finally{p.close();}
});

test('a delayed reveal cannot restore the password after the customer leaves the account tab',async()=>{
  let finishReveal;
  const p=await portal({respond:async path=>path.endsWith('/reveal')?new Promise(resolve=>{finishReveal=resolve;}):null}),{$}=p;
  try {
    $('#revealPassword').click();await settle();$('[data-tab="news"]').click();
    finishReveal({body:{username:'ana-servico',password:'nao-mostrar',expiresInSeconds:60}});await settle();
    assert.equal($('#accessPassword').textContent,'••••••••');assert.equal(p.window.document.body.textContent.includes('nao-mostrar'),false);
  }finally{p.close();}
});

test('installation guides, videos, DNS and Telegram render verified data safely without media requests',async()=>{
  const help={updatedAt:'2026-10-12',guides:[{id:'samsung-guide',device:'Samsung',title:'<img onerror=alert(1)> Guia',steps:['<script>alert(1)</script>','Abra a loja indicada pela equipe.'],apps:[{name:'Aplicativo conferido',url:'https://www.samsung.com/br/support/'},{name:'Link suspeito',url:'https://samsung.com.bad.example.invalid/app'}],videos:[{title:'Vídeo conferido',url:'https://www.youtube.com/watch?v=synthetic'},{title:'Vídeo inválido',url:'javascript:alert(1)'}],sourceUrl:'https://www.samsung.com/br/support/',verifiedAt:'2026-10-12'}],dns:[{name:'Endereço conferido',value:'https://dns.example.invalid',status:'verified',verifiedAt:'2026-10-12',sourceUrl:'https://t.me/test_channel/1'},{name:'Antigo',value:'NAO-EXIBIR-DNS-ANTIGO',status:'stale',verifiedAt:'2026-10-01'}],telegram:{channelUrl:'https://t.me/test_channel',lastSuccessAt:'2026-10-12',status:'current',posts:[{title:'Aviso <script>',content:'<img src=x onerror=alert(1)> Texto do aviso',url:'https://t.me/test_channel/2',publishedAt:'2026-10-12',category:'notices'},{content:'Novidade conferida',url:'https://t.me.bad.example.invalid/3',publishedAt:'2026-10-12',category:'news'},{content:'Guia do canal',url:'https://t.me/test_channel/4',publishedAt:'2026-10-12',category:'guides'}]}};
  const p=await portal({help}),{$,requests}=p;
  try {
    assert.match($('#installationGuides').textContent,/<script>/);assert.equal($('#installationGuides script'),null);assert.equal($('#installationGuides img'),null);
    assert.equal($('#installationGuides iframe'),null);assert.equal($('#installationGuides video'),null);
    assert.equal($('#installationGuides a[href*="bad.example"]'),null);assert.equal($('#installationGuides a[href^="javascript:"]'),null);
    assert.equal(requests.some(r=>String(r.url).includes('youtube')),false);assert.equal($('#installationGuides .video-link').target,'_blank');
    assert.match($('#dnsList').textContent,/dns.example.invalid/);assert.equal($('#dnsList').textContent.includes('NAO-EXIBIR-DNS-ANTIGO'),false);
    $('#dnsList button').click();await settle();assert.deepEqual(p.copied,['https://dns.example.invalid']);
    assert.match($('#noticesPosts').textContent,/<img/);assert.equal($('#noticesPosts img'),null);assert.equal($('#newsPosts a'),null);assert.equal($('#guideChannelResources').hidden,false);
    $('[data-device="Roku"]').click();assert.match($('#installationGuides').textContent,/Ainda não há um guia conferido para Roku/);assert.match($('#installationGuides').textContent,/confirmar o aplicativo/);
  }finally{p.close();}
});

for(const [tab,panel] of [['guias','guides'],['avisos','notices'],['novidades','news'],['pagamentos','payments']]) {
  test(`personal portal link opens ${tab} after consuming the token`,async()=>{
    const account=baseAccount();account.privacy.acknowledgedAt=null;
    const p=await portal({url:`https://portal.example.invalid/cliente?aba=${tab}#${'b'.repeat(43)}`,account});
    try{assert.equal(p.window.location.hash,'');assert.equal(p.$(`#${panel}`).hidden,false);assert.equal(p.$('#profile').hidden,true);assert.equal(p.requests.filter(r=>r.url.endsWith('/payments')).length,0);assert.equal(p.requests.filter(r=>r.url.endsWith('/reveal')).length,0);}finally{p.close();}
  });
}

test('missing content or access keeps a useful fallback and never requests a password',async()=>{
  const p=await portal({respond:async path=>path.endsWith('/me/access')||path.endsWith('/me/help')?{status:503,body:{error:'Fonte indisponível'}}:null});
  try{assert.equal(p.$('#login').textContent,'ana-servico');assert.equal(p.$('#revealPassword').disabled,true);assert.match(p.$('#helpStatus').textContent,/aguardam atualização/);assert.match(p.$('#dnsList').textContent,/Nenhum DNS/);assert.match(p.$('#newsPosts').textContent,/Nenhuma novidade/);assert.equal(p.requests.some(r=>r.url.endsWith('/reveal')),false);}finally{p.close();}
});

test('anonymous entry does not fetch access, help or service password',async()=>{
  const p=await portal({respond:async path=>path.endsWith('/me')?{status:401,body:{error:'Entre pelo WhatsApp'}}:null});
  try{assert.equal(p.$('#entry').hidden,false);assert.equal(p.requests.some(r=>r.url.includes('/me/access')||r.url.endsWith('/me/help')),false);assert.equal(p.$('#account').hidden,true);}finally{p.close();}
});

test('verified private Telegram channel has an honest fallback and the customer opens it explicitly',async()=>{
  const help=baseHelp();help.telegram={channelUrl:'https://t.me/+'+'a'.repeat(24),lastSuccessAt:null,status:'private',posts:[]};
  const p=await portal({help,access:{...baseAccess(),source:'https://bitpanel.vip/lists/verified-list'}});
  try{assert.match(p.$('#accessSource').textContent,/BitPanel/);assert.match(p.$('#noticesStatus').textContent,/acesso restrito/);assert.equal(p.$('#noticesChannel').hidden,false);assert.equal(p.$('#noticesChannel').target,'_blank');assert.equal(p.requests.some(r=>String(r.url).includes('t.me')),false);}finally{p.close();}
});

test('provider publications identify their source and only link to the public notice or news sections',async()=>{
  const help=baseHelp();help.telegram.posts=[{source:'BitPanel',category:'notices',title:'Aviso conferido',content:'Comunicado do serviço.',url:'https://bitpanel.vip/notices',publishedAt:'2026-10-12',verifiedAt:'2026-10-12'},
    {source:'BitPanel',category:'notices',content:'Outro comunicado',url:'https://bitpanel.vip/list/view/12345',publishedAt:'2026-10-12'},
    {source:'BitPanel',category:'news',content:'Novidade com link inválido',url:'https://bitpanel.vip/news?token=private',publishedAt:'2026-10-12'}];
  const p=await portal({help});
  try{assert.match(p.$('#noticesPosts').textContent,/BitPanel · Publicado/);assert.equal(p.$('#noticesPosts a').href,'https://bitpanel.vip/notices');assert.equal(p.window.document.querySelectorAll('#noticesPosts a').length,1);assert.equal(p.$('#newsPosts a'),null);assert.equal(p.requests.some(r=>String(r.url).includes('bitpanel.vip')),false);}finally{p.close();}
});

test('app-specific guides use only own access and current DNS; passwords remain explicit and temporary',async()=>{
  const help=baseHelp();help.guides=[{id:'samsung',device:'Samsung',title:'Instalar na Samsung',steps:['Abra Apps.'],apps:[
    {id:'ss-iptv',name:'SS IPTV',url:'https://ss-iptv.com/',protocols:['m3u'],requirements:['Confira o modelo da TV.'],stepsSupport:['Abra Conteúdo para trocar a lista.'],requiredFields:['playlistUrl'],availability:'model_check_required',sourceUrl:'https://ss-iptv.com/en/users/documents/how-to-upload-playlist',verifiedAt:'2026-10-12'},
    {id:'smarters',name:'Smarters Pro',url:'https://smarterspro.com/?token=nao-expor',protocols:['xtream'],requirements:['<img src=x onerror=alert(1)>'],stepsSupport:['Edite o endereço e salve.','<script>nao-executar</script>'],requiredFields:['username','password','dns'],username:'catalog-user-nao-mostrar',password:'catalog-secret-nao-mostrar',sourceUrl:'https://smarterspro.com/',verifiedAt:'2026-10-12'}
  ]}];help.dns=[{name:'Atual',value:'http://service.example.invalid',status:'current',verifiedAt:'2026-10-12',sourceUrl:'https://bitpanel.vip/notices'},
    {name:'Anterior',value:'NAO-MOSTRAR-DNS-ANTIGO',status:'stale',verifiedAt:'2026-10-01'}];
  const p=await portal({url:'https://portal.example.invalid/cliente?aba=guias',help}),{$,window,requests,timers}=p;
  try{
    const apps=[...window.document.querySelectorAll('.app-guide')];assert.equal(apps.length,2);assert.match(apps[0].textContent,/Antes de instalar/);assert.match(apps[0].textContent,/Solicite à equipe o link/);assert.equal(apps[0].querySelector('[data-reveal-password]'),null);
    assert.match(apps[1].textContent,/ana-servico/);assert.match(apps[1].textContent,/http:\/\/service.example.invalid/);assert.match(apps[1].textContent,/Edite o endereço/);
    assert.equal($('#installationGuides img'),null);assert.equal($('#installationGuides script'),null);assert.equal($('#installationGuides a[href*="token="]'),null);
    assert.equal(window.document.body.textContent.includes('catalog-secret-nao-mostrar'),false);assert.equal(window.document.body.textContent.includes('catalog-user-nao-mostrar'),false);assert.equal(window.document.body.textContent.includes('NAO-MOSTRAR-DNS-ANTIGO'),false);
    assert.equal(requests.some(r=>r.url.endsWith('/reveal')||r.url.endsWith('/support/chat')||r.url.endsWith('/payments')),false);
    apps[1].open=true;await settle();apps[1].querySelector('[data-reveal-password]').click();await settle();assert.equal(apps[1].querySelector('[data-password-value]').textContent,'senha-sintetica');assert.equal($('#accessPassword').textContent,'••••••••');
    const send=()=>$('#supportForm').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));$('#supportQuestion').value='Apareceu senha-sintetica no aplicativo';send();await settle();assert.equal(requests.some(r=>r.url.endsWith('/support/chat')),false);assert.match($('#supportStatus').textContent,/Retire os dados/);
    const timer=[...timers.values()].find(t=>t.delay===60000);assert.ok(timer);timer.callback();assert.equal(apps[1].querySelector('[data-password-value]').textContent,'••••••••');
    apps[1].querySelector('[data-reveal-password]').click();await settle();apps[1].open=false;await settle();assert.equal(apps[1].querySelector('[data-password-value]').textContent,'••••••••');
    apps[0].querySelector('.app-guide-body > button').click();assert.match($('#supportQuestion').value,/SS IPTV/);assert.equal(requests.some(r=>r.url.endsWith('/support/chat')),false);
    assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);assert.equal($('#installationGuides a[href*="username="]'),null);
  }finally{p.close();}
});

test('support chat sends only an explicit question with CSRF and renders answers as safe text',async()=>{
  const p=await portal({url:'https://portal.example.invalid/cliente?aba=guias',respond:async path=>path.endsWith('/support/chat')?{body:{reply:'<img src=x onerror=alert(1)> Abra Apps e procure o aplicativo.',readOnly:true,sources:[{title:'Guia oficial',url:'https://ss-iptv.com/en/users/documents/how-to-upload-playlist'},{title:'Inseguro',url:'javascript:alert(1)'}]}}:null}),{$,window,requests}=p;
  try{
    assert.equal(requests.some(r=>r.url.endsWith('/support/chat')),false);const message='<script>nao-executar</script> Como troco o endereço?';$('#supportQuestion').value=message;
    $('#supportForm').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();const request=requests.find(r=>r.url.endsWith('/support/chat'));
    assert.equal(request.method,'POST');assert.equal(request.headers['X-Portal-CSRF'],'synthetic-csrf');assert.deepEqual(JSON.parse(request.body),{message});assert.equal(JSON.parse(request.body).history,undefined);
    assert.match($('#supportMessages').textContent,/<script>/);assert.match($('#supportMessages').textContent,/<img/);assert.equal($('#supportMessages script'),null);assert.equal($('#supportMessages img'),null);assert.equal($('#supportMessages a[href^="javascript:"]'),null);assert.equal($('#supportMessages a').rel,'noopener noreferrer');
    assert.equal(requests.some(r=>r.url.endsWith('/payments')||r.url.endsWith('/reveal')),false);$('#clearSupport').click();assert.equal($('#supportMessages').childElementCount,0);assert.equal($('#supportQuestion').value,'');assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);
  }finally{p.close();}
});

test('support chat blocks private data and oversize questions before making any request',async()=>{
  const p=await portal({url:'https://portal.example.invalid/cliente?aba=guias'}),{$,window,requests}=p;
  try{
    for(const message of ['senha: segredo-exemplo','token=segredo-exemplo','Meu CPF é 123.456.789-00','Meu telefone é 5511999999999','Contato cliente@example.invalid','https://service.example.invalid/get.php?username=ana&password=segredo']){
      $('#supportQuestion').value=message;$('#supportForm').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.match($('#supportStatus').textContent,/Retire os dados/);
    }
    $('#supportQuestion').value='a'.repeat(501);$('#supportForm').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.match($('#supportStatus').textContent,/até 500/);assert.equal(requests.some(r=>r.url.endsWith('/support/chat')),false);
  }finally{p.close();}
});

test('a delayed support answer is discarded after tab change, hidden page or logout',async()=>{
  for(const leave of ['tab','hidden','logout']){
    let finish;const p=await portal({url:'https://portal.example.invalid/cliente?aba=guias',respond:async path=>path.endsWith('/support/chat')?new Promise(resolve=>{finish=resolve;}):null}),{$,window,requests}=p;
    try{
      $('#supportQuestion').value='Como instalo na TV Samsung?';const send=()=>$('#supportForm').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));send();send();await settle();assert.equal(requests.filter(r=>r.url.endsWith('/support/chat')).length,1);
      if(leave==='tab')$('[data-tab="news"]').click();else if(leave==='hidden'){Object.defineProperty(window.document,'visibilityState',{value:'hidden',configurable:true});window.document.dispatchEvent(new window.Event('visibilitychange'));}else $('#logout').click();
      await settle();finish({body:{reply:'RESPOSTA-TARDIA-NAO-EXIBIR'}});await settle();assert.equal($('#supportMessages').childElementCount,0);assert.equal(window.document.body.textContent.includes('RESPOSTA-TARDIA-NAO-EXIBIR'),false);assert.equal($('#supportQuestion').value,'');
    }finally{p.close();}
  }
});

function playlistHelp() {
  const help=baseHelp();help.guides=[{device:'LG',title:'Instalar na LG',apps:[{id:'ss-iptv-lg',name:'SS IPTV',requiredFields:['playlistUrl'],url:'https://ss-iptv.com/',stepsSupport:['Abra o guia e toque em Mostrar lista.']}]}];
  help.dns=[{name:'DNS atual',value:'http://service.example.invalid',status:'current',verifiedAt:new Date().toISOString(),sourceUrl:'https://bitpanel.vip/notices'}];return help;
}
const playlist='http://service.example.invalid/get.php?username=ana-servico&password=senha-sintetica&type=m3u_plus&output=ts';

test('own protected playlist appears and copies only after explicit reveal, without links, provider requests, storage or AI',async()=>{
  const p=await portal({url:'https://portal.example.invalid/cliente?aba=guias',help:playlistHelp(),respond:async path=>path.endsWith('/reveal')?{body:{username:'ana-servico',password:'senha-sintetica',expiresInSeconds:60,playlistUrl:playlist}}:null}),{$,window,requests,timers}=p;
  try{
    const app=$('.app-guide');app.open=true;await settle();assert.equal(requests.some(r=>r.url.endsWith('/reveal')),false);assert.equal($('[data-playlist-value]').textContent,'Lista protegida');assert.equal($('[data-copy-playlist]').hidden,true);
    $('[data-reveal-playlist]').click();await settle();assert.equal($('[data-playlist-value]').textContent,playlist);assert.equal($('[data-password-value]').textContent,'••••••••');assert.equal($('[data-copy-playlist]').disabled,false);assert.match($('[data-playlist-note]').textContent,/contém sua senha/);
    const request=requests.find(r=>r.url.endsWith('/reveal'));assert.equal(request.method,'POST');assert.equal(request.headers['X-Portal-CSRF'],'synthetic-csrf');assert.equal(request.body,'{}');assert.equal(window.document.querySelector('a[href*="get.php"]'),null);
    $('[data-copy-playlist]').click();await settle();assert.deepEqual(p.copied,[playlist]);assert.equal(requests.some(r=>String(r.url).includes('service.example.invalid')||r.url.endsWith('/payments')),false);
    $('#supportQuestion').value=playlist;$('#supportForm').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.equal(requests.some(r=>r.url.endsWith('/support/chat')),false);
    assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);[...timers.values()].find(t=>t.delay===60000).callback();assert.equal($('[data-playlist-value]').textContent,'Lista protegida');assert.equal($('[data-copy-playlist]').hidden,true);
    $('[data-reveal-playlist]').click();await settle();app.open=false;await settle();assert.equal($('[data-playlist-value]').textContent,'Lista protegida');assert.equal(window.document.body.textContent.includes(playlist),false);
  }finally{p.close();}
});

test('playlist reveal rejects mismatched ownership, endpoints, query fields and stale or ambiguous DNS',async()=>{
  const invalidUrls=[playlist.replace('service.example.invalid','outside.example.invalid'),playlist.replace('username=ana-servico','username=another-user'),playlist.replace('password=senha-sintetica','password=wrong-secret'),playlist.replace('/get.php','/list.php'),playlist.replace('m3u_plus','m3u'),playlist.replace('output=ts','output=hls'),playlist+'&token=extra',playlist+'&username=ana-servico',playlist+'#secret'];
  const options=invalidUrls.map(url=>({url}));options.push({url:playlist,dns:{verifiedAt:new Date(Date.now()-86400001).toISOString()}},{url:playlist,dns:{status:'stale'}},{url:playlist,dns:{sourceUrl:'https://bitpanel.vip/news'}},{url:playlist,secondDns:true},{url:null});
  for(const option of options){
    const help=playlistHelp();if(option.dns)Object.assign(help.dns[0],option.dns);if(option.secondDns)help.dns.push({...help.dns[0],value:'https://second.example.invalid'});
    const p=await portal({url:'https://portal.example.invalid/cliente?aba=guias',help,respond:async path=>path.endsWith('/reveal')?{body:{username:'ana-servico',password:'senha-sintetica',expiresInSeconds:60,playlistUrl:option.url}}:null});
    try{p.$('.app-guide').open=true;await settle();p.$('[data-reveal-playlist]').click();await settle();assert.equal(p.$('[data-playlist-value]').textContent,'Lista protegida');assert.equal(p.$('[data-copy-playlist]').disabled,true);assert.equal(p.window.document.body.textContent.includes('senha-sintetica'),false);assert.match(p.$('#message').textContent,/endereço atual conferido/);}finally{p.close();}
  }
});

test('a delayed playlist reveal cannot restore the secret after closing the app, changing tabs or leaving the session',async()=>{
  for(const leave of ['card','tab','hidden','logout']){
    let finish;const p=await portal({url:'https://portal.example.invalid/cliente?aba=guias',help:playlistHelp(),respond:async path=>path.endsWith('/reveal')?new Promise(resolve=>{finish=resolve;}):null});
    try{p.$('.app-guide').open=true;await settle();p.$('[data-reveal-playlist]').click();await settle();if(leave==='card')p.$('.app-guide').open=false;else if(leave==='tab')p.$('[data-tab="payments"]').click();else if(leave==='hidden'){Object.defineProperty(p.window.document,'visibilityState',{value:'hidden',configurable:true});p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));}else p.$('#logout').click();await settle();finish({body:{username:'ana-servico',password:'senha-sintetica',expiresInSeconds:60,playlistUrl:playlist}});await settle();assert.equal(p.window.document.body.textContent.includes(playlist),false);assert.equal(p.window.document.body.textContent.includes('senha-sintetica'),false);}finally{p.close();}
  }
});
