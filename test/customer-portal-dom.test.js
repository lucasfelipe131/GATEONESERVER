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
