import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import vm from 'node:vm';

test('customer portal renders untrusted fields safely, keeps notices optional, and only creates payment on explicit action',async()=>{
  const html=await readFile(new URL('../public/portal.html',import.meta.url),'utf8'),script=await readFile(new URL('../public/portal.js',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://portal.example.invalid/cliente#'+'a'.repeat(43),runScripts:'outside-only'});
  const {window}=dom,requests=[];
  const account={name:'<img onerror=alert(1)> Ana',email:'',whatsapp_e164:'5511999999701',login:'<script>unsafe</script>',status:'active',plan_code:'monthly',plan_name:'Mensal',price_cents:3000,expires_on:'2026-11-12',payment_methods:['Pix','Cartão de crédito','Boleto'],payments:[],plans:[{code:'monthly',name:'Mensal',price_cents:3000,duration_months:1}],privacy:{ready:true,controller:'Responsável Sintético',contact:'privacy@example.invalid',version:'2026-10-12.1',acknowledgedAt:null,requests:[]},whatsapp_url:'https://wa.me/5511999999700',consent_contact:false,csrf_token:'synthetic-csrf'};
  window.crypto.randomUUID=randomUUID;window.setInterval=()=>1;window.clearInterval=()=>{};
  window.fetch=async(url,options={})=>{requests.push({url,...options});let body=account,status=200;if(url.endsWith('/session'))body={ok:true};if(url.endsWith('/profile'))body={ok:true};if(url.endsWith('/payments')){body={error:'Cobrança de teste bloqueada.'};status=409;}return{ok:status<400,status,json:async()=>structuredClone(body)};};
  try {
    vm.runInContext(script,dom.getInternalVMContext());await new Promise(resolve=>setTimeout(resolve,35));
    const $=selector=>window.document.querySelector(selector);
    assert.equal(window.location.hash,'');assert.equal(window.location.pathname,'/cliente');assert.equal($('#account').hidden,false);
    assert.ok($('#login').textContent.includes('<script>'));assert.equal($('#login script'),null);assert.equal($('#greeting img'),null);
    assert.equal($('#profile').hidden,false);assert.equal($('#profileForm input[name="cpf"]'),null);
    assert.equal($('#profileForm input[name="consentContact"]').checked,false);assert.equal($('#profileForm input[name="consentContact"]').required,false);
    assert.equal($('#profileForm input[name="noticeAcknowledged"]').checked,false);assert.equal($('#profileForm input[name="noticeAcknowledged"]').required,true);
    assert.equal(requests.filter(r=>r.url.endsWith('/payments')).length,0);
    $('[data-tab="payments"]').click();$('[data-plan="monthly"]').click();assert.match($('#selectedPlan').textContent,/30,00/);
    assert.equal(requests.filter(r=>r.url.endsWith('/payments')).length,0);
    $('#createPayment').click();await new Promise(resolve=>setTimeout(resolve,25));
    const payment=requests.find(r=>r.url.endsWith('/payments'));assert.equal(payment.method,'POST');assert.equal(payment.headers['X-Portal-CSRF'],'synthetic-csrf');assert.deepEqual(Object.keys(JSON.parse(payment.body)).sort(),['planCode','requestId']);
    const form=$('#profileForm');form.elements.name.value='Ana Cliente';form.elements.claimedLogin.value='';form.elements.noticeAcknowledged.checked=true;
    form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,25));
    const profile=JSON.parse(requests.find(r=>r.url.endsWith('/profile')).body);assert.equal(profile.email,'');assert.equal(profile.consentContact,false);assert.equal(profile.noticeAcknowledged,true);assert.equal(profile.cpf,undefined);
  }finally{dom.window.close();}
});
