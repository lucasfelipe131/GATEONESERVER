const $=selector=>document.querySelector(selector);
const money=cents=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((cents||0)/100);
const date=value=>value?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo'}).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?`${value}T12:00:00Z`:value)):'—';
const paymentLabels={CREATED:'Aguardando pagamento',PENDING:'Aguardando pagamento',CONFIRMED:'Pagamento confirmado',FAILED:'Pagamento não aprovado',EXPIRED:'Cobrança expirada',CANCELLED:'Cobrança cancelada',REFUNDED:'Pagamento devolvido'};
let account=null,selectedPlan=null,paymentRequestId=null,refreshTimer,paymentInFlight=false;
function element(tag,text,className) { const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(className) node.className=className; return node; }
function showMessage(text,error=false) { $('#message').textContent=text; $('#message').className=`message ${error?'error':'success'}`; }
function showTab(id) { document.querySelectorAll('.tab-panel').forEach(node=>node.hidden=node.id!==id); document.querySelectorAll('.tab').forEach(node=>{node.classList.toggle('active',node.dataset.tab===id); if(node.dataset.tab===id)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');}); }
function whatsappLink(base,text) { try { const url=new URL(base); if(url.protocol!=='https:' || url.hostname!=='wa.me')return null; url.searchParams.set('text',text); return url.href; } catch {return null;} }
function setHelp(node,base,text) { const link=whatsappLink(base,text); node.hidden=!link; if(link){node.href=link;node.target='_blank';node.rel='noreferrer';} }
function safeCheckout(value) { try { const url=new URL(value); return url.protocol==='https:' && !url.username && !url.password && ['www.mercadopago.com.br','mercadopago.com.br','www.mercadopago.com','mercadopago.com'].includes(url.hostname); } catch{return false;} }
async function api(path,options={}) {
  const response=await fetch(`/api/portal/${path}`,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(account?.csrf_token?{'X-Portal-CSRF':account.csrf_token}:{}),...options.headers}});
  const body=await response.json();
  if(!response.ok) { const error=new Error(body.error||'Não foi possível concluir agora.'); error.status=response.status;throw error; }
  return body;
}
function renderPayments() {
  const methods=$('#paymentMethods');methods.replaceChildren();
  for(const method of account.payment_methods) methods.append(element('span',method,'method'));
  if(!account.payment_methods.length) methods.append(element('span','As formas de pagamento aparecem no checkout.','muted'));
  const history=$('#paymentHistory');history.replaceChildren();
  if(!account.payments.length) history.append(element('p','Você ainda não tem pagamentos registrados.','empty'));
  for(const payment of account.payments) {
    const row=element('article',undefined,'payment-row'),info=element('div');
    info.append(element('strong',payment.plan_name||'Assinatura'),element('small',`${date(payment.created_at)} · ${money(payment.amount_cents)}${payment.simulated?' · Simulação':''}`));
    row.append(info,element('span',paymentLabels[payment.status]||'Em conferência',`pill ${payment.status==='CONFIRMED'?'paid':''}`));
    if(payment.checkout_url && safeCheckout(payment.checkout_url)) {const link=element('a','Pagar','primary small');link.href=payment.checkout_url;row.append(link);}
    history.append(row);
  }
  const plans=$('#renewalPlans');plans.replaceChildren();
  const pending=account.payments.find(payment=>['CREATED','PENDING'].includes(payment.status));
  if(pending) {plans.append(element('p',`Já existe uma cobrança pendente de ${money(pending.amount_cents)}${pending.plan_name?` para ${pending.plan_name}`:''}. ${pending.checkout_url?'Use o link acima.':'O link ainda está sendo preparado ou precisa de conferência. Atualize a situação ou peça ajuda pelo WhatsApp.'} Para trocar o plano, peça ajuda pelo WhatsApp.`,'selection'));$('#createPayment').disabled=true;$('#selectedPlan').hidden=true;selectedPlan=null;return;}
  if(!account.plan_code) {plans.append(element('p','Complete seu cadastro. A equipe vai conferir e preparar seu primeiro acesso antes da cobrança.','empty'));$('#createPayment').disabled=true;return;}
  for(const plan of account.plans) { const button=element('button',undefined,'renewal-choice');button.type='button';button.dataset.plan=plan.code;button.append(element('strong',plan.name),element('small',plan.duration_months===1?'1 mês':`${plan.duration_months} meses`),element('b',money(plan.price_cents)));plans.append(button); }
  if(selectedPlan && account.plans.some(plan=>plan.code===selectedPlan.code)) selectPlan(selectedPlan.code);
}
function selectPlan(code) {if(selectedPlan?.code!==code || !paymentRequestId)paymentRequestId=crypto.randomUUID();selectedPlan=account.plans.find(plan=>plan.code===code);document.querySelectorAll('[data-plan]').forEach(node=>node.classList.toggle('selected',node.dataset.plan===code));$('#selectedPlan').hidden=false;$('#selectedPlan').textContent=`Você escolheu ${selectedPlan.name} por ${money(selectedPlan.price_cents)}. Confirme para gerar o link seguro do Mercado Pago.`;$('#createPayment').disabled=paymentInFlight;$('#createPayment').textContent=`Gerar cobrança de ${money(selectedPlan.price_cents)}`;}
function renderAccount(fillProfile=true) {
  $('#entry').hidden=true;$('#account').hidden=false;$('#logout').hidden=false;
  $('#greeting').textContent=account.name?`Olá, ${account.name.trim().split(/\s+/)[0]}!`:'Bem-vindo à sua área!';$('#introText').textContent='Seu acesso, seus pagamentos e seu cadastro. Tudo conectado ao WhatsApp.';
  $('#plan').textContent=account.plan_name||'Vamos preparar seu acesso';$('#price').textContent=account.price_cents?`${money(account.price_cents)} por ciclo`:'Cadastro em andamento';$('#expiry').textContent=date(account.expires_on);$('#subscriptionStatus').textContent=({active:'Ativo',late:'Em atraso',suspended:'Suspenso',cancelled:'Cancelado',lead:'Novo cadastro'})[account.status]||'Em acompanhamento';
  $('#login').textContent=account.login||'Seu login ainda será conferido pela equipe';$('#copyLogin').hidden=!account.login;$('#accessNote').textContent='Não envie sua senha, CPF ou dados de cartão pelo WhatsApp. Para recuperar ou configurar o acesso, fale com a equipe.';
  setHelp($('#accessHelp'),account.whatsapp_url,'Preciso de ajuda com meu acesso Gate One Pro.');setHelp($('#whatsappHelp'),account.whatsapp_url,'MENU');
  const form=$('#profileForm');if(fillProfile){form.elements.name.value=account.name||'';form.elements.email.value=account.email||'';form.elements.whatsapp.value=account.whatsapp_e164;form.elements.claimedLogin.value=account.login||'';form.elements.consentContact.checked=Boolean(account.privacy.acknowledgedAt && account.consent_contact);form.elements.noticeAcknowledged.checked=Boolean(account.privacy.acknowledgedAt);}
  $('#noticeOwner').textContent=account.privacy.ready?`Responsável: ${account.privacy.controller}. Contato de privacidade: ${account.privacy.contact}. Aviso ${account.privacy.version}.`:'O aviso de privacidade precisa ser configurado antes de salvar o cadastro.';$('#saveProfile').disabled=!account.privacy.ready;
  const requests=$('#privacyRequests');requests.replaceChildren();for(const request of account.privacy.requests) requests.append(element('p',`${date(request.created_at)} · ${({ACCESS:'Cópia dos dados',CORRECTION:'Correção',ERASURE:'Eliminação'})[request.request_type]} · ${request.status==='REVIEWED'?'Atendimento encerrado; consulte o resultado com a equipe':'Pedido registrado para a equipe'}`,'muted'));
  renderPayments();
}
async function refresh(fillProfile=false) {account=await api('me');renderAccount(fillProfile);}
async function showEntry(error) {clearInterval(refreshTimer);account=null;$('#account').hidden=true;$('#entry').hidden=false;$('#logout').hidden=true;if(error)showMessage(error,true);const notice=await api('privacy').catch(()=>null);setHelp($('#entryWhatsapp'),notice?.whatsapp_url,'PORTAL');}
document.querySelectorAll('[data-tab]').forEach(node=>node.addEventListener('click',()=>showTab(node.dataset.tab)));
$('#renewalPlans').addEventListener('click',event=>{const button=event.target.closest('[data-plan]');if(button)selectPlan(button.dataset.plan);});
$('#createPayment').addEventListener('click',async()=>{if(!selectedPlan || paymentInFlight)return;paymentInFlight=true;const button=$('#createPayment');button.disabled=true;showMessage('Preparando sua cobrança…');try {const payment=await api('me/payments',{method:'POST',body:JSON.stringify({planCode:selectedPlan.code,requestId:paymentRequestId})});if(!safeCheckout(payment.checkoutUrl))throw new Error('O link precisa ser conferido pela equipe.');location.assign(payment.checkoutUrl);} catch(error){showMessage(error.message,true);paymentInFlight=false;await refresh().catch(()=>{});button.disabled=!selectedPlan;}});
$('#profileForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;$('#saveProfile').disabled=true;try {const result=await api('me/profile',{method:'PATCH',body:JSON.stringify({name:form.elements.name.value,email:form.elements.email.value,claimedLogin:form.elements.claimedLogin.value,noticeAcknowledged:form.elements.noticeAcknowledged.checked,noticeVersion:account.privacy.version,consentContact:form.elements.consentContact.checked})});await refresh(true);showMessage(result.identityReview?'Cadastro salvo. A equipe vai conferir o vínculo com o login informado.':'Seu cadastro foi salvo. Suas escolhas de privacidade ficaram registradas.');}catch(error){showMessage(error.message,true);}finally{$('#saveProfile').disabled=!account?.privacy.ready;}});
$('#refresh').addEventListener('click',()=>refresh().then(()=>showMessage('Situação atualizada.')).catch(error=>showMessage(error.message,true)));
$('#copyLogin').addEventListener('click',()=>navigator.clipboard.writeText(account.login).then(()=>showMessage('Login copiado.')).catch(()=>showMessage('Selecione o login e copie no seu aparelho.')));
$('#withdraw').addEventListener('click',async()=>{try{await api('me/privacy/withdraw',{method:'POST',body:'{}'});await refresh(true);showMessage('Sua autorização para avisos opcionais foi retirada. Você pode continuar usando sua conta.');}catch(error){showMessage(error.message,true);}});
document.querySelectorAll('[data-privacy]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api('me/privacy/requests',{method:'POST',body:JSON.stringify({type:button.dataset.privacy,requestId:crypto.randomUUID()})});await refresh();showMessage('Seu pedido foi registrado para a equipe. Você pode acompanhar por aqui e pelo WhatsApp.');}catch(error){showMessage(error.message,true);}finally{button.disabled=false;}}));
$('#logout').addEventListener('click',async()=>{try{await api('logout',{method:'POST',body:'{}'});await showEntry();showMessage('Você saiu da sua conta.');}catch(error){showMessage(error.message,true);}});
async function start() {const fragment=location.hash.slice(1),legacy=location.pathname.startsWith('/cliente/')?location.pathname.split('/').pop():null;const token=fragment||legacy;if(token)history.replaceState(null,'','/cliente');try{if(token)await api('session',{method:'POST',body:JSON.stringify({token})});await refresh(true);if(!account.name || !account.privacy.acknowledgedAt)showTab('profile');refreshTimer=setInterval(()=>{if(document.visibilityState==='visible')refresh().catch(error=>{if(error.status===401)showEntry(error.message);});},30000);}catch(error){await showEntry(token?error.message:null);}}
start();
