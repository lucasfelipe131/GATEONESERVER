const $=selector=>document.querySelector(selector);
const money=cents=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((cents||0)/100);
const date=value=>{if(!value)return '—';const parsed=new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?`${value}T12:00:00Z`:value);return Number.isNaN(parsed.getTime())?'—':new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo'}).format(parsed);};
const paymentLabels={CREATED:'Aguardando pagamento',PENDING:'Aguardando pagamento',CONFIRMED:'Pagamento confirmado',FAILED:'Pagamento não aprovado',EXPIRED:'Cobrança expirada',CANCELLED:'Cobrança cancelada',REFUNDED:'Pagamento devolvido'};
const initialTab=({guias:'guides',avisos:'notices',novidades:'news',pagamentos:'payments'})[new URLSearchParams(location.search).get('aba')]||null;
const officialHosts=['samsung.com','samsungapps.com','lg.com','lgappstv.com','roku.com','play.google.com','apps.apple.com','smartone-iptv.com','ss-iptv.com','smarterspro.com','iboplayer.com','bitplatform.vip','bitpanel.vip','t.me','youtube.com','youtu.be','youtube-nocookie.com'];
let account=null,access=null,help=null,selectedDevice='all',selectedPlan=null,paymentRequestId=null,refreshTimer,paymentInFlight=false,passwordTimer,passwordVisible=false,passwordLoading=false,passwordRequest=0,supportRequest=0,supportInFlight=false,supportController=null;
function element(tag,text,className) { const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(className) node.className=className; return node; }
function showMessage(text,error=false) { $('#message').textContent=text; $('#message').className=`message ${error?'error':'success'}`; }
function passwordButtons() {return document.querySelectorAll('[data-reveal-password], [data-reveal-playlist]');}
function hidePassword() {passwordRequest+=1;clearTimeout(passwordTimer);passwordVisible=false;passwordLoading=false;document.querySelectorAll('[data-password-value]').forEach(node=>node.textContent='••••••••');document.querySelectorAll('[data-playlist-value]').forEach(node=>node.textContent='Lista protegida');document.querySelectorAll('[data-copy-playlist]').forEach(node=>{node.disabled=true;node.hidden=true;});passwordButtons().forEach(node=>{node.textContent=node.hasAttribute('data-reveal-playlist')?'Mostrar lista':'Mostrar senha';node.disabled=!access?.passwordAvailable;});document.querySelectorAll('[data-password-note]').forEach(node=>node.textContent=node.hasAttribute('data-playlist-note')?'A lista contém sua senha. Ela fica visível por até 60 segundos; use apenas no seu aplicativo ou no site oficial indicado.':'Sua senha só aparece quando você pedir e fica visível por até 60 segundos.');}
function showTab(id) {if(!document.querySelector(`#${id}.tab-panel`))return;hidePassword();if(id!=='guides')clearSupport();document.querySelectorAll('.tab-panel').forEach(node=>node.hidden=node.id!==id); document.querySelectorAll('.tab').forEach(node=>{node.classList.toggle('active',node.dataset.tab===id); if(node.dataset.tab===id)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');}); }
function whatsappLink(base,text) { try { const url=new URL(base); if(url.protocol!=='https:' || url.hostname!=='wa.me')return null; url.searchParams.set('text',text); return url.href; } catch {return null;} }
function setHelp(node,base,text) { const link=whatsappLink(base,text); node.hidden=!link; if(link){node.href=link;node.target='_blank';node.rel='noreferrer';} }
function safeCheckout(value) { try { const url=new URL(value); return url.protocol==='https:' && !url.username && !url.password && ['www.mercadopago.com.br','mercadopago.com.br','www.mercadopago.com','mercadopago.com'].includes(url.hostname); } catch{return false;} }
function safeContentUrl(value,{telegramOnly=false,bitpanelPublicationOnly=false}={}) {try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash||[...url.searchParams.keys()].some(key=>/user|pass|token|secret|auth|key|playlist/i.test(key)))return null;const allowed=telegramOnly?['t.me']:bitpanelPublicationOnly?['bitpanel.vip']:officialHosts;if(bitpanelPublicationOnly&&(url.search||!/^\/(notices|news)\/?$/.test(url.pathname)))return null;return allowed.some(host=>url.hostname===host||url.hostname.endsWith(`.${host}`))?url.href:null;}catch{return null;}}
function contentLink(label,value,className='text-link',options) {const url=safeContentUrl(value,options);if(!url)return null;const link=element('a',label,className);link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';return link;}
async function api(path,options={}) {
  const response=await fetch(`/api/portal/${path}`,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(account?.csrf_token?{'X-Portal-CSRF':account.csrf_token}:{}),...options.headers}});
  const body=await response.json();
  if(!response.ok) { const error=new Error(body.error||'Não foi possível concluir agora.'); error.status=response.status;throw error; }
  return body;
}
function renderAccess() {
  const username=access?.username||account?.login||'';
  $('#login').textContent=username||'Seu usuário ainda será conferido pela equipe';$('#copyLogin').hidden=!username;
  if(!access?.passwordAvailable&&passwordVisible)hidePassword();passwordButtons().forEach(node=>node.disabled=!access?.passwordAvailable||passwordLoading);
  const status=String(access?.status||'').toLowerCase();
  $('#accessNote').textContent=access?.passwordAvailable?'Guarde estes dados com cuidado. Não envie sua senha pelo WhatsApp.':status==='stale'?'Seu acesso precisa de uma nova conferência. Peça ajuda pelo WhatsApp.':'Sua senha ainda não está disponível nesta área. A equipe precisa conferir seu acesso.';
  let source='Cadastro do serviço';try{if(access?.source==='bitpanel'||new URL(access?.source).hostname==='bitpanel.vip')source='BitPanel';}catch{if(access?.source==='manual')source='Cadastro conferido pela equipe';}
  $('#accessSource').textContent=access?.syncedAt?`${source} · Última conferência: ${date(access.syncedAt)}`:'';
}
function usableDns(dns) {
  if(!['verified','active','current'].includes(String(dns?.status||'').toLowerCase())||!dns.verifiedAt||Number.isNaN(new Date(dns.verifiedAt).getTime())||typeof dns.value!=='string')return false;
  try{const url=new URL(/^https?:\/\//i.test(dns.value)?dns.value:`http://${dns.value}`);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/';}catch{return false;}
}
function appField(label,value,copyLabel) {
  const field=element('div',undefined,'app-field');field.append(element('span',label,'field-label'));
  if(!value){field.append(element('p','Este dado precisa de uma conferência da equipe.','muted'));return field;}
  const line=element('div',undefined,'login-line'),copy=element('button',copyLabel||'Copiar','quiet');copy.type='button';copy.addEventListener('click',()=>copyText(value,`${label} copiado.`));line.append(element('code',value),copy);field.append(line);return field;
}
function appPasswordField() {
  const field=element('div',undefined,'app-field');field.dataset.passwordField='';field.append(element('span','Senha do serviço','field-label'));
  const line=element('div',undefined,'login-line password-line'),value=element('strong','••••••••'),button=element('button','Mostrar senha','quiet');value.dataset.passwordValue='';value.setAttribute('aria-live','polite');button.type='button';button.dataset.revealPassword='';button.disabled=!access?.passwordAvailable;button.addEventListener('click',()=>revealAccessPassword(button));line.append(value,button);field.append(line);
  const note=element('p','Sua senha só aparece quando você pedir e fica visível por até 60 segundos.','source-note');note.dataset.passwordNote='';field.append(note);if(!access?.passwordAvailable)field.append(element('p','A equipe precisa conferir seu acesso antes de mostrar a senha.','muted'));return field;
}
function appPlaylistField() {
  const field=element('div',undefined,'app-field');field.dataset.playlistField='';field.append(element('span','Link da lista (M3U)','field-label'));
  const value=element('code','Lista protegida','dns-value playlist-value');value.dataset.playlistValue='';value.setAttribute('aria-live','polite');field.append(value);
  const actions=element('div',undefined,'guide-links'),show=element('button','Mostrar lista','quiet'),copy=element('button','Copiar lista','quiet');show.type='button';show.dataset.revealPlaylist='';show.disabled=!access?.passwordAvailable;show.addEventListener('click',()=>revealAccessSecret(show,'playlist'));copy.type='button';copy.dataset.copyPlaylist='';copy.disabled=true;copy.hidden=true;copy.addEventListener('click',()=>{if(passwordVisible&&!copy.disabled&&value.textContent!=='Lista protegida')copyText(value.textContent,'Lista copiada. Cole somente no seu aplicativo ou no site oficial indicado.');});actions.append(show,copy);field.append(actions);
  const note=element('p','A lista contém sua senha. Ela fica visível por até 60 segundos; use apenas no seu aplicativo ou no site oficial indicado.','source-note');note.dataset.passwordNote='';note.dataset.playlistNote='';field.append(note,element('p','Solicite à equipe o link próprio deste aplicativo se a lista não aparecer.','muted'));return field;
}
function renderAppGuide(app,device) {
  const card=element('details',undefined,'app-guide'),summary=element('summary');summary.append(element('strong',app.name||'Aplicativo'),element('span','Ver configuração e troca de endereço','muted'));card.append(summary);
  const body=element('div',undefined,'app-guide-body');
  if(app.availability==='model_check_required')body.append(element('p','Antes de instalar, confira no guia se o modelo da sua TV é compatível.','selection'));
  const protocols=Array.isArray(app.protocols)?app.protocols:[],labels={m3u:'Lista M3U',xtream:'Login com usuário e senha',player_id:'Identificação do aparelho'};
  if(protocols.length){const types=element('div',undefined,'method-list');for(const protocol of protocols){if(labels[protocol])types.append(element('span',labels[protocol],'pill'));}if(types.childElementCount)body.append(types);}
  if(Array.isArray(app.requirements)&&app.requirements.length){const requirements=element('ul',undefined,'app-requirements');for(const requirement of app.requirements.slice(0,12))requirements.append(element('li',String(requirement)));body.append(requirements);}
  if(Array.isArray(app.stepsSupport)&&app.stepsSupport.length){const steps=element('ol',undefined,'guide-steps');for(const step of app.stepsSupport.slice(0,20))steps.append(element('li',String(step)));body.append(steps);}else body.append(element('p','O passo a passo deste aplicativo ainda aguarda conferência. Use a fonte abaixo ou peça ajuda à equipe.','muted'));
  const required=Array.isArray(app.requiredFields)?app.requiredFields:[];
  if(required.length){body.append(element('h4','Os dados que este aplicativo pede'));const fields=element('div',undefined,'app-fields');
    if(required.includes('username'))fields.append(appField('Usuário / login',access?.username||'', 'Copiar usuário'));
    if(required.includes('password'))fields.append(appPasswordField());
    if(required.includes('playlistUrl'))fields.append(appPlaylistField());
    if(required.includes('dns')){const dns=(Array.isArray(help?.dns)?help.dns:[]).filter(usableDns);if(dns.length){for(const entry of dns){const field=appField('URL / servidor',String(entry.value),'Copiar endereço');field.append(element('small',`Conferido em ${date(entry.verifiedAt)}`,'source-note'));const source=contentLink('Fonte do endereço →',entry.sourceUrl);if(source)field.append(source);fields.append(field);}}else fields.append(appField('URL / servidor',null));}
    const guidance={activationCode:['Código de ativação','Encontre o código temporário na tela do aplicativo e siga as instruções do guia.'],mac:['MAC do aplicativo','Veja esse identificador na tela do próprio aplicativo. Ele pode ser diferente do MAC da TV.'],deviceKey:['Chave do aparelho','Encontre essa chave na tela do aplicativo. Use-a somente no site oficial indicado.']};
    for(const [key,[title,text]] of Object.entries(guidance)){if(required.includes(key)){const field=element('div',undefined,'app-field');field.append(element('span',title,'field-label'),element('p',text,'muted'));fields.append(field);}}body.append(fields);
  }
  const links=element('div',undefined,'guide-links'),download=contentLink('Site oficial do aplicativo →',app.url,'quiet');if(download)links.append(download);else links.append(element('span','Link oficial aguardando conferência.','muted'));const source=contentLink('Fonte das instruções →',app.sourceUrl);if(source&&source.href!==download?.href)links.append(source);body.append(links);
  if(app.verifiedAt)body.append(element('p',`Guia conferido em ${date(app.verifiedAt)}`,'source-note'));
  const ask=element('button','Me ajude neste aplicativo','quiet');ask.type='button';ask.addEventListener('click',()=>{$('#supportQuestion').value=`Como configuro o ${app.name||'aplicativo'} na TV ${device||'que uso'}?`;$('#supportQuestion').focus();$('#installationAssistant').scrollIntoView?.({behavior:'smooth',block:'start'});});body.append(ask);card.append(body);card.addEventListener('toggle',()=>{if(!card.open)hidePassword();});return card;
}
function renderGuides() {
  hidePassword();
  const list=$('#installationGuides');list.replaceChildren();
  const guides=(Array.isArray(help?.guides)?help.guides:[]).filter(guide=>selectedDevice==='all'||String(guide.device).toLowerCase()===selectedDevice.toLowerCase());
  $('#helpStatus').textContent=help?.updatedAt?`Última atualização dos guias: ${date(help.updatedAt)}`:'Os guias ainda aguardam atualização e conferência da equipe.';
  if(!guides.length)list.append(element('article',`Ainda não há um guia conferido${selectedDevice==='all'?'':` para ${selectedDevice}`}. Fale com a equipe para confirmar o aplicativo adequado ao seu aparelho.`,'card empty'));
  for(const guide of guides) {
    const card=element('article',undefined,'card guide-card');card.append(element('span',guide.device||'Seu aparelho','eyebrow'),element('h3',guide.title||'Como instalar'));
    if(Array.isArray(guide.steps)&&guide.steps.length){const steps=element('ol',undefined,'guide-steps');for(const step of guide.steps)steps.append(element('li',String(step)));card.append(steps);}else card.append(element('p','O passo a passo ainda precisa ser conferido pela equipe.','muted'));
    if(Array.isArray(guide.apps)&&guide.apps.length){card.append(element('h4','Escolha o aplicativo que você usa'));const apps=element('div',undefined,'app-guide-list');for(const app of guide.apps.slice(0,8))apps.append(renderAppGuide(app,guide.device));card.append(apps);}
    if(Array.isArray(guide.videos)&&guide.videos.length){card.append(element('h4','Veja em vídeo'));const videos=element('div',undefined,'guide-links');for(const video of guide.videos){const link=contentLink(`▶ ${video.title||'Assistir ao passo a passo'}`,video.url,'quiet video-link');if(link)videos.append(link);}if(videos.childElementCount)card.append(videos);else card.append(element('p','Os links dos vídeos aguardam conferência.','muted'));}
    const source=contentLink('Ver fonte do guia →',guide.sourceUrl);if(source)card.append(source);card.append(element('p',guide.verifiedAt?`Conferido em ${date(guide.verifiedAt)}`:'Aguardando data de conferência','source-note'));list.append(card);
  }
  const dnsList=$('#dnsList');dnsList.replaceChildren();
  const entries=Array.isArray(help?.dns)?help.dns:[];
  if(!entries.length)dnsList.append(element('p','Nenhum DNS ou endereço do serviço foi conferido para mostrar aqui. Peça os dados atuais à equipe.','empty'));
  for(const dns of entries){const row=element('article',undefined,'dns-row'),info=element('div');const status=String(dns.status||'').toLowerCase(),usable=usableDns(dns);info.append(element('strong',dns.name||'Endereço do serviço'),element('span',usable?'Conferido':status==='stale'?'Precisa de atualização':'Aguardando conferência',`pill ${usable?'paid':''}`));if(usable){info.append(element('code',String(dns.value),'dns-value'));const copy=element('button','Copiar','quiet');copy.type='button';copy.addEventListener('click',()=>copyText(String(dns.value),'Endereço copiado.'));row.append(info,copy);}else{info.append(element('p','Peça à equipe os dados atuais antes de configurar o aplicativo.','muted'));row.append(info);}info.append(element('small',dns.verifiedAt?`Conferido em ${date(dns.verifiedAt)}`:'Sem data de conferência','source-note'));const source=contentLink('Fonte →',dns.sourceUrl);if(source)info.append(source);dnsList.append(row);}
}
function renderPosts() {
  const telegram=help?.telegram,posts=Array.isArray(telegram?.posts)?telegram.posts:[];
  for(const [category,prefix] of [['notices','notices'],['news','news']]){
    const list=$(`#${prefix}Posts`);list.replaceChildren();const selected=posts.filter(post=>post.category===category);
    $(`#${prefix}Status`).textContent=telegram?.status==='private'?'O canal tem acesso restrito. Abra o Telegram pelo botão abaixo para consultar as publicações.':telegram?.lastSuccessAt?`Última sincronização do Telegram: ${date(telegram.lastSuccessAt)}${telegram.status==='stale'?' · A atualização está pendente.':''}`:'As publicações do Telegram ainda aguardam sincronização. Os comunicados já conferidos aparecem abaixo quando disponíveis.';
    if(!selected.length)list.append(element('article',category==='notices'?'Nenhum aviso foi disponibilizado nesta área.':'Nenhuma novidade foi disponibilizada nesta área.','card empty'));
    for(const post of selected)list.append(postCard(post));
    const channel=$(`#${prefix}Channel`),url=safeContentUrl(telegram?.channelUrl,{telegramOnly:true});channel.hidden=!url;if(url){channel.href=url;channel.target='_blank';channel.rel='noopener noreferrer';}
  }
  const resources=$('#guideChannelResources');resources.replaceChildren();const guides=posts.filter(post=>post.category==='guides');resources.hidden=!guides.length;if(guides.length){resources.append(element('h3','Mais guias do serviço'));for(const post of guides)resources.append(postCard(post));}
}
function postCard(post) {const card=element('article',undefined,'card post-card'),provider=post.source==='BitPanel';if(post.title)card.append(element('h3',String(post.title)));card.append(element('p',String(post.content||''),'post-text'),element('small',`${provider?'BitPanel':'Telegram'} · Publicado em ${date(post.publishedAt)}${post.verifiedAt?` · Conferido em ${date(post.verifiedAt)}`:''}`,'source-note'));const link=contentLink(provider?'Ver publicação no BitPanel →':'Abrir publicação original →',post.url,'text-link',provider?{bitpanelPublicationOnly:true}:{telegramOnly:true});if(link)card.append(link);return card;}
async function loadCustomerHelp() {const results=await Promise.allSettled([api('me/access'),api('me/help')]);const metadata=results[0].status==='fulfilled'?results[0].value:null;access=metadata?{username:metadata.username,passwordAvailable:metadata.passwordAvailable===true,source:metadata.source,syncedAt:metadata.syncedAt,status:metadata.status,expiresAt:metadata.expiresAt}:null;help=results[1].status==='fulfilled'?results[1].value:null;renderAccess();renderGuides();renderPosts();}
function copyText(value,message) {return navigator.clipboard?.writeText(value).then(()=>showMessage(message)).catch(()=>showMessage('Selecione o texto e copie no seu aparelho.'))||showMessage('Selecione o texto e copie no seu aparelho.');}
function verifiedPlaylist(value,revealed) {
  if(typeof value!=='string'||value.length>6000)return null;
  try{
    const url=new URL(value),keys=[...url.searchParams.keys()].sort();
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.pathname!=='/get.php'||keys.join(',')!=='output,password,type,username'||url.searchParams.get('username')!==access?.username||url.searchParams.get('password')!==revealed.password||url.searchParams.get('type')!=='m3u_plus'||url.searchParams.get('output')!=='ts')return null;
    const origins=new Set((Array.isArray(help?.dns)?help.dns:[]).flatMap(dns=>{if(!usableDns(dns)||!/^https?:\/\//i.test(dns.value))return [];const age=Date.now()-new Date(dns.verifiedAt).getTime(),source=safeContentUrl(dns.sourceUrl,{bitpanelPublicationOnly:true});if(age<0||age>86400000||!source||!/^\/notices\/?$/.test(new URL(source).pathname))return [];return [new URL(dns.value).origin];}));
    return origins.size===1&&origins.has(url.origin)?url.href:null;
  }catch{return null;}
}
function revealAccessPassword(button) {return revealAccessSecret(button,'password');}
async function revealAccessSecret(button,kind) {
  if(passwordVisible){hidePassword();return;}
  if(!account||!access?.passwordAvailable||passwordLoading)return;
  const field=button.closest('[data-password-field], [data-playlist-field]'),target=field?.querySelector(kind==='playlist'?'[data-playlist-value]':'[data-password-value]'),panel=button.closest('.tab-panel'),app=button.closest('details');
  if(!target||panel?.hidden||(app&&!app.open))return;
  const request=++passwordRequest;passwordLoading=true;passwordButtons().forEach(node=>node.disabled=true);
  try{
    const revealed=await api('me/access/reveal',{method:'POST',body:'{}'});
    if(request!==passwordRequest||!account||document.visibilityState==='hidden'||panel?.hidden||!target.isConnected||(app&&!app.open))return;
    if(revealed.username!==access?.username||typeof revealed.password!=='string'||!revealed.password||revealed.password.length>4096)throw new Error('Sua senha precisa ser conferida pela equipe.');
    const value=kind==='playlist'?verifiedPlaylist(revealed.playlistUrl,revealed):revealed.password;
    if(!value)throw new Error('Sua lista precisa de um endereço atual conferido pela equipe. Peça ajuda pelo WhatsApp.');
    target.textContent=value;passwordVisible=true;button.textContent=kind==='playlist'?'Ocultar lista':'Ocultar senha';
    const copy=field.querySelector('[data-copy-playlist]');if(copy){copy.hidden=false;copy.disabled=false;}
    const seconds=Math.min(60,Math.max(1,Number(revealed.expiresInSeconds)||60));field.querySelector('[data-password-note]').textContent=kind==='playlist'?`A lista contém sua senha. Será ocultada em até ${seconds} segundos e ao sair desta tela. Cole somente no seu aplicativo ou no site oficial indicado.`:`A senha será ocultada em até ${seconds} segundos e ao sair desta tela.`;passwordTimer=setTimeout(hidePassword,seconds*1000);
  }catch(error){if(request===passwordRequest){hidePassword();showMessage(error.message,true);}}
  finally{if(request===passwordRequest){passwordLoading=false;passwordButtons().forEach(node=>node.disabled=!access?.passwordAvailable);}}
}
function clearSupport() {
  supportRequest+=1;supportController?.abort();supportController=null;supportInFlight=false;
  $('#supportMessages').replaceChildren();$('#supportQuestion').value='';$('#sendSupport').disabled=false;$('#sendSupport').textContent='Enviar pergunta';$('#supportStatus').textContent='A pergunta será enviada somente quando você clicar em Enviar.';
}
function supportBubble(label,text,type) {
  const bubble=element('article',undefined,`support-bubble ${type}`);bubble.append(element('strong',label),element('p',text));$('#supportMessages').append(bubble);
  while($('#supportMessages').childElementCount>8)$('#supportMessages').firstElementChild.remove();return bubble;
}
function containsPrivateSupportData(message) {
  if(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d{3}[. -]\d{3}[. -]\d{3}[- ]\d{2}\b|\b\d{10,13}\b|\b(?:55[ .()-]*)?\(?\d{2}\)?[ .-]*\d{4,5}[ .-]*\d{4}\b|\b(?:senha|password|token|api[_ -]?key|c[oó]digo|device[_ -]?key)\s*[:=]\s*\S+/i.test(message))return true;
  if(/https?:\/\/\S*[?&](?:username|password|token|auth|key|secret)=/i.test(message))return true;
  return [...document.querySelectorAll('[data-password-value], [data-playlist-value]')].some(node=>!['••••••••','Lista protegida'].includes(node.textContent)&&node.textContent&&message.includes(node.textContent));
}
async function sendSupport(event) {
  event.preventDefault();if(!account||supportInFlight||$('#guides').hidden)return;
  const message=$('#supportQuestion').value.trim();
  if(!message||message.length>500){$('#supportStatus').textContent='Escreva uma pergunta de até 500 caracteres.';return;}
  if(containsPrivateSupportData(message)){$('#supportStatus').textContent='Retire os dados pessoais, senhas, códigos e links privados antes de enviar. Conte apenas o aparelho, o aplicativo e a dificuldade.';return;}
  const request=++supportRequest;supportInFlight=true;supportController=new AbortController();$('#sendSupport').disabled=true;$('#sendSupport').textContent='Buscando orientação…';$('#supportStatus').textContent='Consultando os guias da equipe…';supportBubble('Você',message,'customer');$('#supportQuestion').value='';
  try{
    const result=await api('me/support/chat',{method:'POST',body:JSON.stringify({message}),signal:supportController.signal});
    if(request!==supportRequest||!account||$('#guides').hidden||document.visibilityState==='hidden')return;
    if(typeof result.reply!=='string'||!result.reply.trim()||result.reply.length>4000)throw new Error('A orientação não está disponível agora. Continue com a equipe pelo WhatsApp.');
    const bubble=supportBubble('Assistente',result.reply,'assistant');
    if(Array.isArray(result.sources)){const sources=element('div',undefined,'guide-links');for(const source of result.sources.slice(0,5)){const link=contentLink(source.title||'Ver guia usado',source.url);if(link)sources.append(link);}if(sources.childElementCount)bubble.append(sources);}
    $('#supportStatus').textContent='Precisa de mais ajuda? Descreva o próximo passo ou continue com a equipe pelo WhatsApp.';
  }catch(error){if(request===supportRequest){$('#supportStatus').textContent=error.name==='AbortError'?'A pergunta foi cancelada.':error.status===429?'Você já fez várias perguntas. Aguarde um pouco ou peça ajuda à equipe pelo WhatsApp.':error.message;}}
  finally{if(request===supportRequest){supportController=null;supportInFlight=false;$('#sendSupport').disabled=false;$('#sendSupport').textContent='Enviar pergunta';}}
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
  $('#greeting').textContent=account.name?`Olá, ${account.name.trim().split(/\s+/)[0]}!`:'Bem-vindo à sua área!';$('#introText').textContent='Seu acesso, instalação na TV, pagamentos e novidades. Tudo conectado ao WhatsApp.';
  $('#plan').textContent=account.plan_name||'Vamos preparar seu acesso';$('#price').textContent=account.price_cents?`${money(account.price_cents)} por ciclo`:'Cadastro em andamento';$('#expiry').textContent=date(account.expires_on);$('#subscriptionStatus').textContent=({active:'Ativo',late:'Em atraso',suspended:'Suspenso',cancelled:'Cancelado',lead:'Novo cadastro'})[account.status]||'Em acompanhamento';
  renderAccess();
  setHelp($('#accessHelp'),account.whatsapp_url,'Preciso de ajuda com meu acesso Gate One Pro.');setHelp($('#whatsappHelp'),account.whatsapp_url,'MENU');setHelp($('#installationHelp'),account.whatsapp_url,'Preciso de ajuda para instalar o serviço na minha TV.');
  const form=$('#profileForm');if(fillProfile){form.elements.name.value=account.name||'';form.elements.email.value=account.email||'';form.elements.whatsapp.value=account.whatsapp_e164;form.elements.claimedLogin.value=account.login||'';form.elements.consentContact.checked=Boolean(account.privacy.acknowledgedAt && account.consent_contact);form.elements.noticeAcknowledged.checked=Boolean(account.privacy.acknowledgedAt);}
  $('#noticeOwner').textContent=account.privacy.ready?`Responsável: ${account.privacy.controller}. Contato de privacidade: ${account.privacy.contact}. Aviso ${account.privacy.version}.`:'O aviso de privacidade precisa ser configurado antes de salvar o cadastro.';$('#saveProfile').disabled=!account.privacy.ready;
  const requests=$('#privacyRequests');requests.replaceChildren();for(const request of account.privacy.requests) requests.append(element('p',`${date(request.created_at)} · ${({ACCESS:'Cópia dos dados',CORRECTION:'Correção',ERASURE:'Eliminação'})[request.request_type]} · ${request.status==='REVIEWED'?'Atendimento encerrado; consulte o resultado com a equipe':'Pedido registrado para a equipe'}`,'muted'));
  renderPayments();
}
async function refresh(fillProfile=false) {account=await api('me');renderAccount(fillProfile);}
async function showEntry(error) {clearInterval(refreshTimer);access=null;help=null;hidePassword();clearSupport();account=null;renderAccess();renderGuides();$('#account').hidden=true;$('#entry').hidden=false;$('#logout').hidden=true;if(error)showMessage(error,true);const notice=await api('privacy').catch(()=>null);setHelp($('#entryWhatsapp'),notice?.whatsapp_url,'PORTAL');}
document.querySelectorAll('[data-tab]').forEach(node=>node.addEventListener('click',()=>showTab(node.dataset.tab)));
$('#renewalPlans').addEventListener('click',event=>{const button=event.target.closest('[data-plan]');if(button)selectPlan(button.dataset.plan);});
$('#createPayment').addEventListener('click',async()=>{if(!selectedPlan || paymentInFlight)return;paymentInFlight=true;const button=$('#createPayment');button.disabled=true;showMessage('Preparando sua cobrança…');try {const payment=await api('me/payments',{method:'POST',body:JSON.stringify({planCode:selectedPlan.code,requestId:paymentRequestId})});if(!safeCheckout(payment.checkoutUrl))throw new Error('O link precisa ser conferido pela equipe.');location.assign(payment.checkoutUrl);} catch(error){showMessage(error.message,true);paymentInFlight=false;await refresh().catch(()=>{});button.disabled=!selectedPlan;}});
$('#profileForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;$('#saveProfile').disabled=true;try {const result=await api('me/profile',{method:'PATCH',body:JSON.stringify({name:form.elements.name.value,email:form.elements.email.value,claimedLogin:form.elements.claimedLogin.value,noticeAcknowledged:form.elements.noticeAcknowledged.checked,noticeVersion:account.privacy.version,consentContact:form.elements.consentContact.checked})});await refresh(true);showMessage(result.identityReview?'Cadastro salvo. A equipe vai conferir o vínculo com o login informado.':'Seu cadastro foi salvo. Suas escolhas de privacidade ficaram registradas.');}catch(error){showMessage(error.message,true);}finally{$('#saveProfile').disabled=!account?.privacy.ready;}});
$('#refresh').addEventListener('click',()=>refresh().then(loadCustomerHelp).then(()=>showMessage('Situação atualizada.')).catch(error=>showMessage(error.message,true)));
$('#copyLogin').addEventListener('click',()=>copyText(access?.username||account?.login||'','Usuário copiado.'));
$('#deviceFilters').addEventListener('click',event=>{const button=event.target.closest('[data-device]');if(!button)return;selectedDevice=button.dataset.device;document.querySelectorAll('[data-device]').forEach(node=>{const selected=node.dataset.device===selectedDevice;node.classList.toggle('selected',selected);node.setAttribute('aria-pressed',String(selected));});renderGuides();});
$('#revealPassword').addEventListener('click',()=>revealAccessPassword($('#revealPassword')));
$('#supportForm').addEventListener('submit',sendSupport);$('#clearSupport').addEventListener('click',clearSupport);
document.addEventListener('visibilitychange',()=>{hidePassword();if(document.visibilityState==='hidden')clearSupport();});window.addEventListener('pagehide',()=>{hidePassword();clearSupport();});
$('#withdraw').addEventListener('click',async()=>{try{await api('me/privacy/withdraw',{method:'POST',body:'{}'});await refresh(true);showMessage('Sua autorização para avisos opcionais foi retirada. Você pode continuar usando sua conta.');}catch(error){showMessage(error.message,true);}});
document.querySelectorAll('[data-privacy]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api('me/privacy/requests',{method:'POST',body:JSON.stringify({type:button.dataset.privacy,requestId:crypto.randomUUID()})});await refresh();showMessage('Seu pedido foi registrado para a equipe. Você pode acompanhar por aqui e pelo WhatsApp.');}catch(error){showMessage(error.message,true);}finally{button.disabled=false;}}));
$('#logout').addEventListener('click',async()=>{hidePassword();clearSupport();try{await api('logout',{method:'POST',body:'{}'});await showEntry();showMessage('Você saiu da sua conta.');}catch(error){showMessage(error.message,true);}});
async function start() {const fragment=location.hash.slice(1),legacy=location.pathname.startsWith('/cliente/')?location.pathname.split('/').pop():null;const token=fragment||legacy;if(token)history.replaceState(null,'','/cliente');try{if(token)await api('session',{method:'POST',body:JSON.stringify({token})});await refresh(true);await loadCustomerHelp();if(initialTab)showTab(initialTab);else if(!account.name || !account.privacy.acknowledgedAt)showTab('profile');refreshTimer=setInterval(()=>{if(document.visibilityState==='visible')refresh().catch(error=>{if(error.status===401)showEntry(error.message);});},30000);}catch(error){await showEntry(token?error.message:null);}}
start();
