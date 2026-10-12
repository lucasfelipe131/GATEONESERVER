import test from 'node:test';
import assert from 'node:assert/strict';
import { readBitPanelAccessFromPage, readBitPanelLinkedAccess, readBitPanelCustomerInformation, parseBitPanelDnsLinks, parseBitPanelCustomerNotices } from '../src/integrations/bitpanel.js';

const config={BITPANEL_BASE_URL:'https://bitpanel.vip',BITPANEL_LOGIN_URL:'https://bitpanel.vip/login'};
const binding={listId:'12345',username:'client.one',owner:'Gate One Pro Server'};
function fixture({rows=[['12345','','Gate One Pro Server','Ativa','client.one','','31/12/2026']],detailUsername='client.one',detailId='12345',next=false,
  labelFields=1,legacyFields=0,detailRows=1,flatLegacy=false,usernameLabels=1,passwordRows=1}={}) {
  const calls={passwordReads:0,boldReads:0,writes:0,urls:[],searches:[]};let currentUrl;
  const cells=row=>({count:async()=>row.length,nth:index=>({innerText:async()=>row[index]})});
  const detailText=pattern=>{
    if(pattern.source.includes('Usuário'))return`Usuário: ${detailUsername}`;
    if(pattern.source.includes('Senha')){calls.passwordReads++;return'Senha: synthetic-access';}
    return'Data de validade: 31/12/2026';
  };
  const fields=(count,name)=>({count:async()=>count,nth:()=>({isVisible:async()=>true,fill:async value=>{calls.searches.push({name,value});}})});
  const page={
    url:()=>currentUrl,
    goto:async url=>{calls.urls.push(url);currentUrl=url.includes('/view/')?`https://bitpanel.vip/list/view/${detailId}`:url;},
    waitForTimeout:async()=>{},
    locator:selector=>{
      if(selector==='table tbody')return{waitFor:async()=>{}};
      if(selector==='table thead th')return{allInnerTexts:async()=>['ID','','Proprietário','Estado','Usuário','','Validade']};
      if(selector==='table tbody tr')return{count:async()=>rows.length,nth:i=>({locator:()=>cells(rows[i])})};
      if(selector==='li')return{filter:({hasText})=>({
        count:async()=>hasText.source.includes('Senha')?passwordRows:detailRows,
        innerText:async()=>detailText(hasText)
      })};
      assert.equal(selector,"input[placeholder='Buscar' i], input[placeholder='Pesquisar' i], input[placeholder='Buscar por nome' i], input[placeholder='Pesquisar por nome' i], input[type='search']");
      return fields(legacyFields,'legacy');
    },
    getByLabel:(label,options)=>{assert.equal(label,'Buscar por nome');assert.deepEqual(options,{exact:true});return fields(labelFields,'Buscar por nome');},
    getByRole:()=>({count:async()=>1,isEnabled:async()=>next,click:async()=>{calls.writes++;}}),
    getByText:pattern=>({count:async()=>pattern.source.includes('Usuário')?usernameLabels:1,
      first:()=>({waitFor:async()=>{}}),innerText:async()=>{
        if(flatLegacy)return detailText(pattern);
        calls.boldReads++;return pattern.source.includes('Usuário')?'Usuário:':pattern.source.includes('Senha')?'Senha:':'Data de validade:';
      }})
  };
  return{page,calls};
}

test('linked BitPanel reader checks ID, username and owner before reading a password; no actuator',async()=>{
  const {page,calls}=fixture();const result=await readBitPanelAccessFromPage(page,config,binding);
  assert.equal(result.password,'synthetic-access');assert.equal(result.listId,'12345');assert.equal(result.sourceUrl,'https://bitpanel.vip/list/view/12345');
  assert.equal(calls.passwordReads,1);assert.equal(calls.writes,0);assert.deepEqual(calls.urls,['https://bitpanel.vip/list','https://bitpanel.vip/list/view/12345']);
  assert.deepEqual(calls.searches,[{name:'Buscar por nome',value:'client.one'}]);assert.equal(calls.boldReads,0);
});

test('BitPanel reader uses an exact labelled name search and rejects ambiguous or missing search fields',async()=>{
  for(const options of [{labelFields:2,legacyFields:1},{labelFields:0,legacyFields:2},{labelFields:0,legacyFields:0}]){
    const {page,calls}=fixture(options);
    await assert.rejects(readBitPanelAccessFromPage(page,config,binding),{code:'BITPANEL_READ_UNAVAILABLE'});
    assert.equal(calls.searches.length,0);assert.equal(calls.passwordReads,0);assert.equal(calls.writes,0);
  }
  const {page,calls}=fixture({labelFields:0,legacyFields:1});
  await readBitPanelAccessFromPage(page,config,binding);
  assert.deepEqual(calls.searches,[{name:'legacy',value:'client.one'}]);
});

test('BitPanel detail reads accept a unique flat legacy value and reject duplicate detail labels before secret reads',async()=>{
  const legacy=fixture({detailRows:0,passwordRows:0,flatLegacy:true});
  assert.equal((await readBitPanelAccessFromPage(legacy.page,config,binding)).username,'client.one');
  assert.equal(legacy.calls.passwordReads,1);
  for(const options of [{detailRows:2},{passwordRows:2},{detailRows:0,usernameLabels:2,flatLegacy:true}]){
    const {page,calls}=fixture(options);
    await assert.rejects(readBitPanelAccessFromPage(page,config,binding),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
    assert.equal(calls.passwordReads,0);assert.equal(calls.writes,0);
  }
  const boldOnly=fixture({detailRows:0,passwordRows:0});
  await assert.rejects(readBitPanelAccessFromPage(boldOnly.page,config,binding),{code:'BITPANEL_READ_UNAVAILABLE'});
  assert.equal(boldOnly.calls.passwordReads,0);
});

test('BitPanel reader fails closed on mismatches, duplicates and incomplete pagination without reading passwords',async()=>{
  for(const options of [
    {rows:[['99999','','Gate One Pro Server','Ativa','client.one','','31/12/2026']]},
    {rows:[['12345','','Other reseller','Ativa','client.one','','31/12/2026']]},
    {rows:[['12345','','Gate One Pro Server','Ativa','someone.else','','31/12/2026']]},
    {rows:[]},{next:true},{detailUsername:'someone.else'},{detailId:'99999'},
    {rows:[['12345','','Gate One Pro Server','Ativa','client.one','','31/12/2026'],['88888','','Gate One Pro Server','Ativa','client.one','','31/12/2026']]}
  ]){
    const {page,calls}=fixture(options);
    await assert.rejects(readBitPanelAccessFromPage(page,config,binding),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
    assert.equal(calls.passwordReads,0);assert.equal(calls.writes,0);
  }
});

test('BitPanel reader exposes only fixed error codes and never passes invalid binding or external origin to a session',async()=>{
  let sessions=0;const withSession=async()=>{sessions++;throw Error('CAPTCHA refused synthetic private credentials');};
  await assert.rejects(readBitPanelLinkedAccess(config,binding,{withSession}),error=>error.code==='BITPANEL_READ_REAUTH_REQUIRED'&&!error.message.includes('synthetic'));
  for(const patch of [{listId:'12345/../9'},{username:''},{owner:'Other reseller'}])await assert.rejects(readBitPanelLinkedAccess(config,{...binding,...patch},{withSession}),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
  await assert.rejects(readBitPanelLinkedAccess({...config,BITPANEL_BASE_URL:'https://outside.invalid'},binding,{withSession}),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
  await assert.rejects(readBitPanelLinkedAccess({...config,BITPANEL_LOGIN_URL:'https://outside.invalid/login'},binding,{withSession}),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
  assert.equal(sessions,1);
});

test('DNS parser requires an explicitly reviewed source and omits private addresses, embedded credentials and login links',()=>{
  const candidates=[{label:'DNS',url:'http://auth.urlcld.com'},
    {label:'DNS',url:'http://127.0.0.1'},{label:'DNS',url:'http://localhost'},
    {label:'DNS',url:'https://user:secret@auth.urlcld.com'},
    {label:'DNS',url:'https://auth.urlcld.com/get.php?username=foo&password=bar'},
    {label:'Minha conta',url:'https://bitpanel.vip'}];
  assert.deepEqual(parseBitPanelDnsLinks(candidates,{sourceUrl:'https://bitpanel.vip/notices'}),[]);
  const output=parseBitPanelDnsLinks(candidates,{sourceUrl:'https://bitpanel.vip/notices',reviewedSourcePaths:['/notices']});
  assert.equal(output.length,1);assert.equal(output[0].url,'http://auth.urlcld.com/');
  assert.deepEqual(parseBitPanelDnsLinks(candidates,{sourceUrl:'https://bitpanel.vip/admin',reviewedSourcePaths:['/notices']}),[]);
});

test('notices promote only the latest explicitly designated new DNS and retain links to the original notice',()=>{
  const parsed=parseBitPanelCustomerNotices([
    {title:'Atualização',publishedLabel:'Por Equipe — 08/10/2026 00:13',content:'Troque http://auth.urlsync.gy. Utilize a nova DNS: http://auth.urlcld.com',links:['http://auth.urlsync.gy','http://auth.urlcld.com']},
    {title:'Aviso anterior',publishedLabel:'Por Equipe — 01/10/2026 08:00',content:'Utilize a nova DNS: http://auth.urlsync.gy',links:[]}
  ]);
  assert.equal(parsed.dns.length,1);assert.equal(parsed.dns[0].url,'http://auth.urlcld.com/');assert.equal(parsed.dnsVerified,true);
  assert.equal(parsed.notices[0].sourceUrl,'https://bitpanel.vip/notices');assert.equal(parsed.notices[0].publishedAt,'2026-10-08T00:13:00-03:00');
  assert.equal(parsed.notices[0]._fullText,undefined);
  assert.equal(parseBitPanelCustomerNotices([{title:'Última orientação',publishedLabel:'08/10/2026 00:13',content:'A equipe atualizará a orientação em breve.',links:[]}]).dnsVerified,false);
});

test('customer information reads only reviewed public-facing sections, returns provenance and omits playlist credentials',async()=>{
  let currentUrl;const urls=[];
  const page={url:()=>currentUrl,goto:async url=>{urls.push(url);currentUrl=url;},locator:selector=>{
    if(selector==='a[href*="t.me/"]')return{count:async()=>1,first:()=>({getAttribute:async()=> 'https://t.me/+OkM9So6d9npjODRh'})};
    assert.equal(selector,'.notices .notice-body');return{first:()=>({waitFor:async()=>{}}),evaluateAll:async()=>[{title:currentUrl.endsWith('/news')?'Novidades':'Avisos',
      publishedLabel:'Publicado por Equipe 08/10/2026 às 00:13',content:currentUrl.endsWith('/news')?'Conteúdo adicionado':'Utilize a nova DNS: http://auth.urlcld.com. Lista: https://auth.urlcld.com/get.php?username=example&password=private',
      links:['https://auth.urlcld.com/get.php?username=example&password=private','https://bitplatform.vip/']}]};
  }};
  const result=await readBitPanelCustomerInformation(config,{withSession:async(_config,task)=>task(page)});
  assert.deepEqual(urls,['https://bitpanel.vip/notices','https://bitpanel.vip/news','https://bitpanel.vip/']);
  assert.equal(result.posts.length,2);assert.equal(result.posts[1].category,'news');assert.equal(result.dns[0].value,'http://auth.urlcld.com');
  assert.equal(result.telegram.channelUrl,'https://t.me/+OkM9So6d9npjODRh');assert.equal(result.telegram.sourceUrl,'https://bitpanel.vip/');
  assert.equal(JSON.stringify(result).includes('password=private'),false);assert.match(result.posts[0].content,/link protegido/);
  const expired={...page,goto:async()=>{currentUrl='https://bitpanel.vip/login';}};
  await assert.rejects(readBitPanelCustomerInformation(config,{withSession:async(_config,task)=>task(expired)}),{code:'BITPANEL_READ_REAUTH_REQUIRED'});
});

test('a newer DNS announcement that cannot be verified does not promote an old DNS from history',()=>{
  const result=parseBitPanelCustomerNotices([
    {title:'Mais novo',publishedLabel:'10/10/2026 00:13',content:'Utilize a nova DNS: consulte o suporte.',links:[]},
    {title:'Antigo',publishedLabel:'08/10/2026 00:13',content:'Utilize a nova DNS: http://auth.urlsync.gy',links:[]}
  ]);
  assert.equal(result.dnsVerified,false);assert.deepEqual(result.dns,[]);
  assert.throws(()=>parseBitPanelCustomerNotices([{title:'Inválido',publishedLabel:'32/14/2026',content:'Teste'}]),{code:'BITPANEL_READ_UNAVAILABLE'});
});
