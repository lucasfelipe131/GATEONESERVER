import test from 'node:test';
import assert from 'node:assert/strict';
import {BITPANEL_LOGIN_SELECTORS,readBitPanelExactMissingAccesses} from '../src/integrations/bitpanel.js';

const NOW=new Date('2026-10-13T12:00:00.000Z');
const config={BITPANEL_BASE_URL:'https://bitpanel.vip',BITPANEL_LOGIN_URL:'https://bitpanel.vip/login',
  BITPANEL_STORAGE_STATE:'synthetic-stored-session',BITPANEL_USERNAME:'synthetic-provider-user',BITPANEL_PASSWORD:'synthetic-provider-password'};
const row=(id,username,patch={})=>({id,username,owner:'Gate One Pro Server',state:'Ativa',expiry:'31/12/2026',...patch});

function fixture({pages=[[row('12345','synthetic.one')]],headers=['ID','Proprietário','Estado','Usuário','Validade'],
  details={},loadingMs=0,nextCount=1,staleNext=false,redirect='',detailRedirect='',loginForm=false,captcha=false,
  detailLoginForm=false,networkTimeout=false,headersAfterPage,clock=()=>new Date(NOW),forbidNonTargetMetadata=false,
  afterBatch,hiddenRowText=false}={}){
  const calls={sessions:0,passwordReads:0,expiryReads:0,earlyReads:0,networkWaits:0,paginationWaits:0,navigationClicks:0,
    financialClicks:0,searchFills:0,loginFills:0,pageBatches:0,rowRPCs:0,nonTargetMetadataReads:0,urls:[],detailIds:[]};
  let currentUrl='',pageIndex=0,ready=true,pending,sessionConfig;
  const hydrate=index=>{
    if(!loadingMs){pageIndex=index;ready=true;return;}
    ready=false;pending=new Promise(resolve=>setTimeout(()=>{pageIndex=index;ready=true;resolve();},loadingMs));
  };
  const sourceRows=()=>pages[pageIndex]||[];
  const rendered=row=>row.cells||[row.id,row.owner,row.state,row.username,row.expiry];
  const domRows=()=>sourceRows().map(item=>({querySelectorAll:selector=>{
    assert.equal(selector,'td');return rendered(item).map((value,index)=>({textContent:hiddenRowText?`${value}hidden`:value,get innerText(){
      if([1,2,4].includes(index)&&item.username!=='synthetic.one'&&item.username!=='synthetic.two'){
        calls.nonTargetMetadataReads++;if(forbidNonTargetMetadata)throw Error('Non-target private metadata must remain in the browser');
      }
      return value;
    }}));
  }}));
  const visibleForm=()=>currentUrl.includes('/view/')?detailLoginForm:loginForm;
  const detail=()=>{
    const id=currentUrl.split('/').at(-1),original=pages.flat().find(item=>item.id===id)||row(id,'synthetic.one');
    return{...original,password:'synthetic-own-password',...(details[id]||{})};
  };
  const detailText=pattern=>{
    const item=detail();
    if(pattern.source.includes('Usuário'))return`Usuário: ${item.username}`;
    if(pattern.source.includes('Senha')){calls.passwordReads++;return`Senha: ${item.password}`;}
    calls.expiryReads++;return`Data de validade: ${item.expiry}`;
  };
  const hiddenFields=(visible=false)=>({count:async()=>visible?1:0,nth:()=>({isVisible:async()=>visible,
    fill:async()=>{calls.loginFills++;},click:async()=>{calls.financialClicks++;}})});
  const page={
    url:()=>currentUrl,
    goto:async url=>{
      calls.urls.push(url);
      if(url.includes('/view/')){calls.detailIds.push(url.split('/').at(-1));currentUrl=detailRedirect||url;}
      else{currentUrl=redirect||url;hydrate(0);}
    },
    waitForLoadState:async state=>{assert.equal(state,'networkidle');calls.networkWaits++;if(networkTimeout)throw Error('synthetic private network error');await pending;},
    waitForFunction:async(fn,args)=>{
      calls.paginationWaits++;await pending;
      const previousDocument=globalThis.document;
      globalThis.document={querySelectorAll:selector=>{
        assert.equal(selector,'table tbody tr');return domRows();
      }};
      try{if(!fn(args))throw Error('synthetic stale pagination');}finally{globalThis.document=previousDocument;}
    },
    getByRole:(role,{name,exact})=>{
      assert.equal(role,'button');assert.equal(name,'Next page');assert.equal(exact,true);
      return{count:async()=>nextCount,isEnabled:async()=>pageIndex<pages.length-1,
        click:async()=>{calls.navigationClicks++;hydrate(staleNext?pageIndex:pageIndex+1);}};
    },
    getByText:pattern=>({first:()=>({waitFor:async()=>{}}),count:async()=>1,innerText:async()=>detailText(pattern)}),
    locator:selector=>{
      if(Object.values(BITPANEL_LOGIN_SELECTORS).includes(selector))return hiddenFields(visibleForm());
      if(selector.includes('iframe['))return hiddenFields(captcha);
      if(selector==='table thead th')return{first:()=>({waitFor:async()=>{}}),allInnerTexts:async()=>{
        if(!ready)calls.earlyReads++;return pageIndex&&headersAfterPage?headersAfterPage:headers;
      }};
      if(selector==='table tbody tr')return{evaluateAll:async(fn,args)=>{
        calls.pageBatches++;if(!ready)calls.earlyReads++;const result=fn(domRows(),args);await afterBatch?.();return result;
      },count:async()=>{calls.rowRPCs++;if(!ready)calls.earlyReads++;return sourceRows().length;},nth:index=>({locator:cellSelector=>{
        calls.rowRPCs++;
        assert.equal(cellSelector,'td');const cells=rendered(sourceRows()[index]);return{count:async()=>cells.length,nth:i=>({innerText:async()=>cells[i]})};
      }})};
      if(selector==='li')return{filter:({hasText})=>({count:async()=>1,innerText:async()=>detailText(hasText)})};
      assert.fail(`Unexpected DOM selector in read-only fixture: ${selector}`);
    }
  };
  const withSession=async(received,task)=>{calls.sessions++;sessionConfig=received;return task(page);};
  return{page,calls,withSession,clock,get sessionConfig(){return sessionConfig;}};
}
const read=(f,usernames=['synthetic.one'],options={})=>readBitPanelExactMissingAccesses(config,usernames,{withSession:f.withSession,now:f.clock,...options});
const noFinancialActions=f=>{assert.equal(f.calls.financialClicks,0);assert.equal(f.calls.searchFills,0);assert.equal(f.calls.loginFills,0);};
const noExportedSecrets=result=>{
  const serialized=JSON.stringify(result);
  for(const value of ['synthetic.one','synthetic.two','synthetic-own-password','synthetic-provider-password','12345','https://bitpanel.vip/list/view/'])
    assert.equal(serialized.includes(value),false,value);
  assert.deepEqual(Object.keys(result),['status','counts']);
};

test('exact missing-access lookup scans hydrated pages and only returns private details for literal, unique GateOne rows',async()=>{
  const f=fixture({pages:[[row('12345','synthetic.one'),row('98765','synthetic.one.extra',{owner:'Other reseller'})],
    [row('23456','synthetic.two'),row('34567','foreign.other',{owner:'Other reseller'})]],loadingMs:15});
  const result=await read(f,['synthetic.one','synthetic.two','missing.exact']);
  assert.deepEqual(result.counts,{requested:3,scannedPages:2,scannedRows:4,verified:2,notFound:1,rejected:0,rejectionReasons:{}});
  assert.equal(result.observations.length,3);assert.equal(result.observations[0].password,'synthetic-own-password');
  assert.equal(result.observations[0].expiresOn,'2026-12-31');assert.equal(result.observations[0].verifiedAt,NOW.toISOString());
  assert.equal(result.observations[1].username,'synthetic.two');assert.deepEqual(result.observations[2],{requestIndex:2,status:'NOT_FOUND'});
  assert.deepEqual(f.calls.detailIds,['12345','23456']);assert.equal(f.calls.passwordReads,2);assert.equal(f.calls.earlyReads,0);
  assert.equal(f.calls.navigationClicks,1);assert.equal(f.calls.paginationWaits,1);assert.ok(f.calls.networkWaits>=3);
  assert.equal(f.calls.pageBatches,2);assert.equal(f.calls.rowRPCs,0);assert.equal(f.calls.nonTargetMetadataReads,0);
  assert.equal(f.sessionConfig.BITPANEL_USERNAME,'');assert.equal(f.sessionConfig.BITPANEL_PASSWORD,'');
  noExportedSecrets(result);noFinancialActions(f);
});

test('duplicate login or list IDs anywhere in later pages block secret reads instead of silently overwriting a map',async()=>{
  for(const [second,reason] of [[row('23456','synthetic.one'),'DUPLICATE_LOGIN'],
    [row('23456','SYNTHETIC.ONE'),'DUPLICATE_LOGIN'],[row('12345','foreign.other',{owner:'Other reseller'}),'DUPLICATE_LIST_ID']]){
    const f=fixture({pages:[[row('12345','synthetic.one')],[second]]}),result=await read(f);
    assert.equal(result.counts.verified,0);assert.equal(result.counts.rejected,1);assert.deepEqual(result.counts.rejectionReasons,{[reason]:1});
    assert.equal(f.calls.passwordReads,0);assert.deepEqual(f.calls.detailIds,[]);noExportedSecrets(result);noFinancialActions(f);
  }
});

test('all requested usernames must match literal provider values, with no fuzzy, name or case conversion',async()=>{
  const f=fixture({pages:[[row('12345','SYNTHETIC.ONE'),row('23456','synthetic.one.extra')]]}),result=await read(f);
  assert.equal(result.counts.notFound,1);assert.equal(result.counts.verified,0);assert.equal(f.calls.passwordReads,0);noExportedSecrets(result);
});

test('a unique legacy Status header accepts only subscription states, while explicit Estado has precedence over presence',async()=>{
  const legacy=fixture({headers:['ID','Proprietário','Status','Usuário','Validade']}),result=await read(legacy);
  assert.equal(result.counts.verified,1);assert.equal(result.observations[0].subscriptionStatus,'active');noFinancialActions(legacy);
  const presence=fixture({headers:['ID','Proprietário','Status','Usuário','Validade'],pages:[[row('12345','synthetic.one',{state:'Online'})]]}),blocked=await read(presence);
  assert.deepEqual(blocked.counts.rejectionReasons,{PROVIDER_STATE_UNVERIFIED:1});assert.equal(presence.calls.passwordReads,0);
  const current=fixture({headers:['ID','Proprietário','Status','Estado','Usuário','Validade'],
    pages:[[row('12345','synthetic.one',{cells:['12345','Gate One Pro Server','Online','Ativa','synthetic.one','31/12/2026']})]]}),currentResult=await read(current);
  assert.equal(currentResult.counts.verified,1);assert.equal(currentResult.observations[0].subscriptionStatus,'active');
});

test('foreign ownership, unsupported states and invalid calendar dates are rejected before passwords or detail navigation',async()=>{
  for(const [patch,reason] of [[{owner:'Other reseller'},'FOREIGN_OWNER'],[{state:'Online'},'PROVIDER_STATE_UNVERIFIED'],
    [{state:'Cancelada'},'PROVIDER_STATE_UNVERIFIED'],[{expiry:'31/02/2026'},'INVALID_EXPIRY'],
    [{expiry:'31/12/2026 ou 01/01/2027'},'INVALID_EXPIRY'],[{expiry:'2026-12-31'},'INVALID_EXPIRY']]){
    const f=fixture({pages:[[row('12345','synthetic.one',patch)]]}),result=await read(f);
    assert.deepEqual(result.counts.rejectionReasons,{[reason]:1});assert.equal(f.calls.passwordReads,0);assert.deepEqual(f.calls.detailIds,[]);
    noExportedSecrets(result);noFinancialActions(f);
  }
  const late=fixture({pages:[[row('12345','synthetic.one',{state:'Expirada',expiry:'10/10/2026'})]]}),result=await read(late);
  assert.equal(result.observations[0].subscriptionStatus,'late');assert.equal(result.observations[0].expiresOn,'2026-10-10');
});

test('detail ID/login/date mismatches cannot reveal a password or produce an import observation',async()=>{
  for(const [options,code] of [[{detailRedirect:'https://bitpanel.vip/list/view/99999'},'BITPANEL_READ_LINK_UNVERIFIED'],
    [{details:{12345:{username:'foreign.other'}}},'BITPANEL_READ_LINK_UNVERIFIED']]){
    const f=fixture(options);await assert.rejects(read(f),{code});assert.equal(f.calls.passwordReads,0);noFinancialActions(f);
  }
  for(const expiry of ['01/01/2027','31/02/2026']){
    const f=fixture({details:{12345:{expiry}}}),result=await read(f);
    assert.deepEqual(result.counts.rejectionReasons,{DETAIL_EXPIRY_CHANGED:1});assert.equal(f.calls.passwordReads,0);noExportedSecrets(result);
  }
});

test('pagination completeness, stable header identity and asynchronous readiness fail closed without partial observations',async()=>{
  for(const [options,readOptions,code] of [[{pages:[[row('12345','synthetic.one')],[row('23456','other')]]},{maxPages:1},'BITPANEL_READ_UNAVAILABLE'],
    [{pages:[[row('12345','synthetic.one')],[row('23456','other')]],staleNext:true},{},'BITPANEL_READ_TIMEOUT'],
    [{pages:[[row('12345','synthetic.one')],[row('23456','other')],[row('12345','synthetic.one')]]},{},'BITPANEL_READ_UNAVAILABLE'],
    [{nextCount:0},{},'BITPANEL_READ_UNAVAILABLE'],[{nextCount:2},{},'BITPANEL_READ_UNAVAILABLE'],
    [{headers:['ID','Proprietário','Presença','Usuário','Validade']},{},'BITPANEL_READ_UNAVAILABLE'],
    [{headers:['ID','Proprietário','Estado','Usuário','Usuário','Validade']},{},'BITPANEL_READ_UNAVAILABLE'],
    [{pages:[[row('12345','synthetic.one')],[row('23456','other')]],headersAfterPage:['ID','Proprietário','Estado','Login','Validade']},{},'BITPANEL_READ_UNAVAILABLE'],
    [{networkTimeout:true},{},'BITPANEL_READ_TIMEOUT'],[{pages:[[]]},{},'BITPANEL_READ_PAGE_NOT_READY']]){
    const f=fixture(options);await assert.rejects(read(f,['synthetic.one'],readOptions),{code});assert.equal(f.calls.passwordReads,0);noFinancialActions(f);
  }
});

test('redirects, login forms and CAPTCHA on list or details require fresh human authentication without bypass',async()=>{
  for(const [options,code] of [[{redirect:'https://outside.invalid/list'},'BITPANEL_READ_LINK_UNVERIFIED'],
    [{redirect:'https://bitpanel.vip/login'},'BITPANEL_READ_REAUTH_REQUIRED'],[{loginForm:true},'BITPANEL_READ_REAUTH_REQUIRED'],
    [{captcha:true},'BITPANEL_READ_REAUTH_REQUIRED'],[{detailLoginForm:true},'BITPANEL_READ_REAUTH_REQUIRED'],
    [{detailRedirect:'https://outside.invalid/list/view/12345'},'BITPANEL_READ_LINK_UNVERIFIED']]){
    const f=fixture(options);await assert.rejects(read(f),{code});assert.equal(f.calls.passwordReads,0);noFinancialActions(f);
  }
});

test('input scope and origin checks run before the session, and provider errors never disclose usernames, passwords or URLs',async()=>{
  let sessions=0;const withSession=async()=>{sessions++;throw Error('synthetic.one synthetic-provider-password private provider failure');};
  for(const usernames of [[],Array.from({length:14},(_,i)=>`synthetic.${i}`),['synthetic.one','SYNTHETIC.ONE'],[' synthetic.one'],['synthetic\none']])
    await assert.rejects(readBitPanelExactMissingAccesses(config,usernames,{withSession}),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
  for(const maxPages of [0,101,1.5])await assert.rejects(readBitPanelExactMissingAccesses(config,['synthetic.one'],{withSession,maxPages}),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
  for(const patch of [{BITPANEL_BASE_URL:'https://outside.invalid'},{BITPANEL_LOGIN_URL:'https://outside.invalid/login'}])
    await assert.rejects(readBitPanelExactMissingAccesses({...config,...patch},['synthetic.one'],{withSession}),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
  assert.equal(sessions,0);
  await assert.rejects(readBitPanelExactMissingAccesses(config,['synthetic.one'],{withSession}),error=>
    error.code==='BITPANEL_READ_UNAVAILABLE'&&!error.message.includes('synthetic')&&!error.message.includes('private'));
  const captcha=async()=>{throw Error('CAPTCHA synthetic-provider-password');};
  await assert.rejects(readBitPanelExactMissingAccesses(config,['synthetic.one'],{withSession:captcha}),{code:'BITPANEL_READ_REAUTH_REQUIRED'});
  await assert.rejects(readBitPanelExactMissingAccesses({...config,BITPANEL_STORAGE_STATE:''},['synthetic.one']),{code:'BITPANEL_READ_REAUTH_REQUIRED'});
});

test('stale snapshot and invalid passwords stay private; saving refreshed storage remains an explicit existing callback',async()=>{
  let time=NOW.getTime(),calls=0;const clock=()=>{calls++;return new Date(time+(calls>1?61_000:0));};
  const stale=fixture({clock}),result=await read(stale);
  assert.deepEqual(result.counts.rejectionReasons,{STALE_OBSERVATION:1});assert.equal(stale.calls.passwordReads,0);noExportedSecrets(result);
  const invalid=fixture({details:{12345:{password:'synthetic\nprivate'}}}),bad=await read(invalid);
  assert.deepEqual(bad.counts.rejectionReasons,{PASSWORD_UNVERIFIED:1});assert.equal(bad.observations[0].password,undefined);noExportedSecrets(bad);
  const save=()=>{},f=fixture();await read(f,['synthetic.one'],{onSaveStorageState:save});
  assert.equal(f.sessionConfig.saveBitPanelStorageState,save);noFinancialActions(f);
});

test('hundreds of rows use one batch RPC, keep non-target metadata inside the page and emit only immutable aggregate progress',async()=>{
  const rows=Array.from({length:300},(_,index)=>row(String(20000+index),index===227?'synthetic.one':`foreign.${index}`));
  const f=fixture({pages:[rows],forbidNonTargetMetadata:true}),frames=[];
  const result=await read(f,['synthetic.one'],{onProgress:frame=>{assert.equal(Object.isFrozen(frame),true);frames.push(frame);}});
  assert.equal(result.counts.scannedRows,300);assert.equal(result.counts.verified,1);assert.equal(f.calls.pageBatches,1);
  assert.equal(f.calls.rowRPCs,0);assert.equal(f.calls.nonTargetMetadataReads,0);assert.equal(f.calls.passwordReads,1);
  assert.deepEqual(frames.at(-1),{phase:'COMPLETE',scannedPages:1,scannedRows:300,verified:1,notFound:0,rejected:0});
  const phases=new Set(['STARTING_SESSION','OPENING_LIST','READING_PAGE','PAGE_SCANNED','PAGINATING','CHECKING_CANDIDATES','READING_DETAIL','COMPLETE']);
  for(const frame of frames){
    assert.deepEqual(Object.keys(frame),['phase','scannedPages','scannedRows','verified','notFound','rejected']);assert.ok(phases.has(frame.phase));
    for(const [key,value] of Object.entries(frame))if(key!=='phase')assert.ok(Number.isSafeInteger(value)&&value>=0);
  }
  for(const privateValue of ['synthetic.one','foreign.','synthetic-own-password','synthetic-provider-password','https://bitpanel.vip','20227'])
    assert.equal(JSON.stringify(frames).includes(privateValue),false);
  noExportedSecrets(result);noFinancialActions(f);
});

test('empty and incomplete DOM batches report PAGE_NOT_READY rather than declaring an absent customer',async()=>{
  for(const pages of [[[]],[[row('12345','synthetic.one',{cells:['12345','Gate One Pro Server','Ativa']})]]]){
    const f=fixture({pages}),frames=[];
    await assert.rejects(read(f,['synthetic.one'],{onProgress:frame=>frames.push(frame)}),error=>{
      assert.equal(error.code,'BITPANEL_READ_PAGE_NOT_READY');assert.equal(error.lookupProgress.phase,'READING_PAGE');
      assert.equal(error.lookupProgress.scannedPages,0);assert.equal(error.lookupProgress.scannedRows,0);assert.equal(error.lookupProgress.notFound,0);
      assert.equal(JSON.stringify(error).includes('synthetic'),false);return true;
    });
    assert.equal(frames.at(-1).phase,'READING_PAGE');assert.equal(f.calls.passwordReads,0);noFinancialActions(f);
  }
});

test('failed pagination and global deadlines retain only the safe last phase and counters',async()=>{
  const f=fixture({pages:[[row('12345','synthetic.one')],[row('23456','other')]],staleNext:true});
  await assert.rejects(read(f),error=>{
    assert.equal(error.code,'BITPANEL_READ_TIMEOUT');assert.deepEqual(error.lookupProgress,
      {phase:'PAGINATING',scannedPages:1,scannedRows:1,verified:0,notFound:0,rejected:0});
    assert.equal(JSON.stringify(error).includes('synthetic'),false);assert.equal(JSON.stringify(error).includes('12345'),false);return true;
  });
  const originalNow=Date.now;let elapsed=0;Date.now=()=>elapsed;
  try{
    await assert.rejects(readBitPanelExactMissingAccesses(config,['synthetic.one'],{withSession:async()=>{
      elapsed=120_001;throw Error('synthetic.one synthetic-provider-password Target closed');
    }}),error=>{
      assert.equal(error.code,'BITPANEL_READ_TIMEOUT');assert.equal(error.lookupProgress.phase,'STARTING_SESSION');
      assert.equal(JSON.stringify(error).includes('synthetic'),false);assert.equal(error.message,'BITPANEL_READ_TIMEOUT');return true;
    });
  }finally{Date.now=originalNow;}
  noFinancialActions(f);
});

test('batched IDs and usernames are validated and progress callbacks cannot expand the original input scope',async()=>{
  for(const item of [row('invalid-id','synthetic.one'),row('12345',''),row('12345','synthetic\none')]){
    const f=fixture({pages:[[item]]});await assert.rejects(read(f),{code:'BITPANEL_READ_UNAVAILABLE'});assert.equal(f.calls.passwordReads,0);
  }
  const names=['synthetic.one'],f=fixture({pages:[[row('12345','synthetic.one'),row('23456','synthetic.two')]]});
  const result=await read(f,names,{onProgress:()=>{names.push('synthetic.two');}});
  assert.equal(result.counts.requested,1);assert.equal(result.counts.verified,1);assert.deepEqual(f.calls.detailIds,['12345']);
  assert.equal(result.observations.length,1);noExportedSecrets(result);noFinancialActions(f);
  await assert.rejects(read(f,['synthetic.one'],{onProgress:123}),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
});

test('a delayed batch RPC cannot assign a fresh timestamp to an old browser snapshot',async()=>{
  let elapsed=0;const f=fixture({clock:()=>new Date(NOW.getTime()+elapsed),afterBatch:()=>{elapsed=61_000;}});
  const result=await read(f);
  assert.equal(result.counts.verified,0);assert.deepEqual(result.counts.rejectionReasons,{STALE_OBSERVATION:1});
  assert.equal(f.calls.passwordReads,0);assert.deepEqual(result.observations,[{requestIndex:0,status:'REJECTED',reason:'STALE_OBSERVATION'}]);
  noExportedSecrets(result);noFinancialActions(f);
});

test('finishing later candidates invalidates an earlier verified row and removes its password from the return value',async()=>{
  let clockReads=0;const f=fixture({pages:[[row('12345','synthetic.one'),row('23456','synthetic.two')]],
    clock:()=>new Date(NOW.getTime()+(++clockReads>=4?61_000:0))});
  const result=await read(f,['synthetic.one','synthetic.two']);
  assert.equal(f.calls.passwordReads,1);assert.equal(result.counts.verified,0);assert.equal(result.counts.rejected,2);
  assert.deepEqual(result.counts.rejectionReasons,{STALE_OBSERVATION:2});
  assert.ok(result.observations.every(item=>item.status==='REJECTED'&&item.reason==='STALE_OBSERVATION'&&item.password===undefined));
  assert.deepEqual(Object.keys(result.observations[0]),['requestIndex','status','reason']);noExportedSecrets(result);noFinancialActions(f);
});

test('saving or closing the read session and an asynchronous COMPLETE callback cannot extend any observation lease',async()=>{
  for(const delayedStep of ['session','progress']){
    let elapsed=0;const f=fixture({clock:()=>new Date(NOW.getTime()+elapsed)});
    const result=await read(f,['synthetic.one'],delayedStep==='session'?{
      withSession:async(cfg,task)=>{const result=await f.withSession(cfg,task);elapsed=61_000;return result;}
    }:{onProgress:async frame=>{if(frame.phase==='COMPLETE')elapsed=61_000;}});
    assert.equal(result.counts.verified,0);assert.deepEqual(result.counts.rejectionReasons,{STALE_OBSERVATION:1});
    assert.equal(result.observations[0].password,undefined);noExportedSecrets(result);noFinancialActions(f);
  }
});

test('pagination readiness uses the same visible cell text as the batch even when hidden text differs',async()=>{
  const f=fixture({pages:[[row('12345','synthetic.one')],[row('23456','other')]],hiddenRowText:true}),result=await read(f);
  assert.equal(result.counts.scannedPages,2);assert.equal(result.counts.verified,1);assert.equal(f.calls.earlyReads,0);
  const stuck=fixture({pages:[[row('12345','synthetic.one')],[row('23456','other')]],hiddenRowText:true,staleNext:true});
  await assert.rejects(read(stuck),{code:'BITPANEL_READ_TIMEOUT'});assert.equal(stuck.calls.passwordReads,0);
  noExportedSecrets(result);noFinancialActions(f);noFinancialActions(stuck);
});
