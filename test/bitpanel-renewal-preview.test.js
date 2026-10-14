import test from 'node:test';
import assert from 'node:assert/strict';
import { previewBitPanelRenewal, renewInBitPanel } from '../src/integrations/bitpanel.js';

const codes = [['monthly',1,3000],['quarterly',3,8500],['semiannual',6,15000],['annual',12,27000]];
const policy = {enabled:true,planLabel:'30',unitPriceCents:3000,maxConnections:1,maxCreditsPerRenewal:12,
  plans:Object.fromEntries(codes.map(([code,months,price])=>[code,{durationMonths:months,priceCents:price,creditCost:months}]))};
const config = {BITPANEL_BASE_URL:'https://bitpanel.vip',BITPANEL_MODE:'disabled',
  BITPANEL_PLAN_LABEL:'30, R$ 30,00',BITPANEL_AUTOMATIC_RENEWAL_POLICY:policy,ARTIFACTS_DIR:'unused-synthetic-directory'};
const subject = (code='monthly',months=1) => ({id:'synthetic-job',bitpanel_list_id:'12345',
  bitpanel_reference:'client.one',bitpanel_owner:'Gate One Pro Server',current_expiry:'2026-12-31',
  expected_expiration:'2027-01-31',plan_code:code,duration_months:months,expected_credit_cost:months,
  automatic_renewal:true,charge_stage:'renewal'});

// This page models the current labelled search and <li><b>Label:</b> value
// markup. Every final click is a local counter; no browser or provider runs.
function fixture(options={}) {
  const calls={finalLookups:0,finalClicks:0,passwordReads:0,closes:0,screenshots:0,menus:0,balanceReads:0,urls:[],waitMs:0,optionClicks:0,
    optionBatches:0,optionReads:0,optionVisibilityReads:0,optionCountReads:0,fieldVisibilityReads:0,
    fieldClickAttempts:0,fieldClickTimeouts:[],optionClickAttempts:0,optionClickTimeouts:[]};
  let currentUrl,dialogVisible=Boolean(options.preexistingDialog),dropdown,selectedMonths=1,selectedPlan='30',openedAt=0,optionOpenedAt=0,planSelectedAt=null;
  const loading=()=>dialogVisible && (options.permanentLoading || calls.waitMs-openedAt<(options.loadingMs || 0));
  const unavailable=()=>Boolean(options.unknownDialog || loading());
  const beforeExpiry=options.beforeExpiry || '31/12/2026';
  const rows=options.rows || [['client.one',beforeExpiry,'Gate One Pro Server','12345','Ativa']];
  const one = text => ({count:async()=>1,first(){return this;},waitFor:async()=>{},innerText:async()=>text});
  const search={isVisible:async()=>true,fill:async value=>assert.equal(value,'client.one')};
  const empty={count:async()=>0};
  const dialog={
    count:async()=>{options.onDialogCount?.(calls);return dialogVisible?(options.duplicateDialogs && calls.menus?2:1):0;},
    isVisible:async()=>{options.onDialogVisible?.(calls);return dialogVisible;},
    waitFor:async({state,timeout})=>{calls.closeWaitTimeout=timeout;assert.equal(dialogVisible,state==='visible');},
    innerText:async()=>options.unknownDialog?'Provider private unexpected notice\nFechar':loading()?'Aguarde...\nFechar':typeof options.quote==='function'?options.quote(calls):options.quote || `Renovar lista #12345.\nValor da unidade: R$ 30,00\nPlano: ${selectedPlan}\nTotal de conexões: 1\nQuantidade de meses: ${selectedMonths}\nTotal em créditos: ${selectedMonths}\nValor total: R$ ${30*selectedMonths},00\nSAIR\nRENOVAR`,
    locator:()=>({count:async()=>unavailable()?(options.loadingFields || 0):2}),
    getByRole:(_role,{name}={})=>{
      if(name===undefined)return{count:async()=>unavailable()?1:4};
      const field = kind => ({count:async()=>kind==='plan'?(unavailable()?0:options.duplicatePlan?2:1):
        unavailable() || (options.validityDelayMs && (planSelectedAt===null || calls.waitMs-planSelectedAt<options.validityDelayMs))?0:1,
        isVisible:async()=>{calls.fieldVisibilityReads++;options.onFieldVisible?.(calls);return!unavailable();},
        click:async args=>{calls.fieldClickAttempts++;calls.fieldClickTimeouts.push(args?.timeout);options.onFieldClick?.(calls);
          if(options.fieldClickThrows)throw Error('private obstructed field');dropdown=kind;optionOpenedAt=calls.waitMs;}});
      if(name instanceof RegExp && name.test('Selecione o plano'))return field('plan');
      if(name instanceof RegExp && name.test('Selecione a validade'))return field('months');
      if(name instanceof RegExp && name.test('Fechar'))return{count:async()=>unavailable() || options.extraClose?1:0,isVisible:async()=>true,click:async args=>{calls.closes++;calls.closeClickTimeout=args?.timeout;dialogVisible=false;options.onCloseClick?.();if(options.closeThrows)throw Error('private close error');}};
      if(name instanceof RegExp && name.test('SAIR'))return{count:async()=>unavailable() || options.missingExit?0:1,isVisible:async()=>true,click:async args=>{calls.closes++;calls.closeClickTimeout=args?.timeout;dialogVisible=false;options.onCloseClick?.();if(options.closeThrows)throw Error('private close error');}};
      assert.equal(name,'Renovar');calls.finalLookups++;
      return{count:async()=>1,click:async()=>{calls.finalClicks++;dialogVisible=false;}};
    }
  };
  const page={
    url:()=>currentUrl,
    goto:async url=>{
      calls.urls.push(url);currentUrl=url;
      if(url.includes('/view/')) {
        const id=calls.finalClicks?options.afterId:options.beforeId;
        if(id)currentUrl=`https://bitpanel.vip/list/view/${id}`;
      }
    },
    waitForTimeout:async ms=>{calls.waitMs+=ms;if(options.redirectOnWait && calls.menus)currentUrl=options.redirectOnWait;},waitForLoadState:async(state,options)=>{assert.equal(state,'networkidle');assert.deepEqual(options,{timeout:20000});},screenshot:async()=>{calls.screenshots++;},
    getByLabel:()=>({count:async()=>1,nth:()=>search}),
    getByText:pattern=>{
      if(pattern.test('Créditos disponíveis: 90')) {
        const labels=options.balanceLabels || [options.balanceLabel ?? 'Créditos disponíveis: 90'];
        return {count:async()=>labels.filter(label=>pattern.test(label)).length,nth:index=>{
          const label=labels.filter(label=>pattern.test(label))[index];
          return {isVisible:async()=>true,innerText:async()=>{
            calls.balanceReads++;return calls.balanceReads>1 && options.balanceAfter!==undefined?options.balanceAfter:label;
          }};
        }};
      }
      return one(pattern.source.includes('Usuário')?'Usuário:':pattern.source.includes('Senha')?'Senha:':'Data de validade:');
    },
    getByRole:(role,{name})=>{
      if(role==='menuitem')return{click:async()=>{assert.equal(name,'Renovar');calls.menus++;dialogVisible=true;openedAt=calls.waitMs;if(options.redirectOnMenu)currentUrl=options.redirectOnMenu;}};
      assert.equal(name,'Next page');return{count:async()=>1,isEnabled:async()=>Boolean(options.next)};
    },
    locator:selector=>{
      if(selector==='table tbody')return{waitFor:async()=>{}};
      if(selector==='li')return{filter:({hasText})=>{
        if(hasText.test('Usuário:'))return one(`Usuário: ${calls.finalClicks?(options.afterUsername || 'client.one'):(options.beforeUsername || 'client.one')}`);
        if(hasText.test('Senha:'))return{...one('Senha: synthetic-secret'),innerText:async()=>{calls.passwordReads++;return'Senha: synthetic-secret';}};
        return one(`Data de validade: ${calls.finalClicks?'31/01/2027':beforeExpiry}`);
      }};
      if(selector==='table thead th')return{first:()=>({waitFor:async()=>{}}),allInnerTexts:async()=>['Usuário','Validade','Proprietário','ID','Estado']};
      if(selector==='table tbody tr')return{count:async()=>rows.length,nth:index=>({locator:()=>({count:async()=>rows[index].length,nth:cell=>one(rows[index][cell])})})};
      if(selector==='.v-dialog--active')return dialog;
      if(selector.startsWith('i[title='))return{count:async()=>1,click:async()=>{}};
      if(selector.startsWith('[role="option"]')) {
        let labels=[...(dropdown==='plan'?(options.planLabels || ['130, R$30,00','30, R$30,00']):(options.monthLabels || ['1 Mês','3 Meses','6 Meses','12 Meses']))],hidden=options.hiddenOptions;
        let batched=false;
        return{evaluateAll:async evaluate=>{
          calls.optionBatches++;
          const ready=calls.waitMs-optionOpenedAt>=(options.optionDelayMs || 0);
          const nodes=ready?labels.map(label=>({innerText:label,isConnected:true,
            ownerDocument:{defaultView:{getComputedStyle:()=>({visibility:hidden?'hidden':'visible',display:'block'})}},
            getBoundingClientRect:()=>({width:100,height:30})})):[];
          const result=evaluate(nodes);
          if(dropdown==='plan'&&!batched) {
            if(options.reorderAfterBatch)labels.reverse();
            if(options.duplicateAfterBatch)labels.push('30, R$30,00');
            if(options.hideAfterBatch)hidden=true;
            if(options.redirectAfterBatch)currentUrl=options.redirectAfterBatch;
          }
          batched=true;return result;
        },count:async()=>{calls.optionCountReads++;return calls.waitMs-optionOpenedAt<(options.optionDelayMs || 0)?0:labels.length;},
        nth:index=>({isVisible:async()=>{calls.optionVisibilityReads++;return!hidden;},innerText:async()=>{
          calls.optionReads++;return options.changeCandidateRead && dropdown==='plan'?'30, R$31,00':labels[index];
        },click:async args=>{
          calls.optionClickAttempts++;calls.optionClickTimeouts.push(args?.timeout);options.onOptionClick?.(calls);
          if(options.optionClickThrows)throw Error('private disabled or obstructed option');
          calls.optionClicks++;
          if(dropdown==='months')selectedMonths=Number(labels[index].match(/^\d+/)[0]);
          else {selectedPlan=labels[index].match(/^\d+/)[0];planSelectedAt=calls.waitMs;}
        }})};
      }
      return empty;
    }
  };
  return{page,calls,withSession:async(_runtime,task)=>task(page)};
}

test('four read-only previews use the real preparation path, close via SAIR and never obtain a final actuator or password',async()=>{
  for(const [code,months] of codes) {
    const f=fixture();const result=await previewBitPanelRenewal(config,subject(code,months),f);
    assert.equal(result.prepared,true);assert.equal(result.submitted,false);assert.equal(result.quote.months,months);
    assert.equal(result.quote.planLabel,'30');
    assert.equal(result.quote.credits,months);assert.equal(result.quote.unitPriceCents,3000);
    assert.deepEqual(result.balance,{status:'verified',availableCredits:90,sufficient:true});
    assert.equal(result.sourceUrl,'https://bitpanel.vip/list/view/12345');
    assert.equal(f.calls.closes,1);assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);
    assert.equal(f.calls.passwordReads,0);assert.equal(f.calls.screenshots,0);
    assert.equal(JSON.stringify(result).includes('client.one'),false);assert.equal(JSON.stringify(result).includes('synthetic-secret'),false);
  }
});

test('preview rejects wrong detail binding, owners, duplicate usernames and incomplete pagination before opening the form',async()=>{
  for(const patch of [{beforeId:'99999'},{beforeUsername:'someone.else'},
    {rows:[['client.one','31/12/2026','Other reseller','12345','Ativa']]},
    {rows:[['client.one','31/12/2026','Gate One Pro Server','12345','Ativa'],['client.one','31/12/2026','Gate One Pro Server','99999','Ativa']]},
    {next:true}]) {
    const f=fixture(patch);await assert.rejects(previewBitPanelRenewal(config,subject(),f),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
    assert.equal(f.calls.menus,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);
  }
});

test('a changed quote closes the form in finally, preserves a fixed error code and cannot submit',async()=>{
  const f=fixture({quote:'Renovar lista #12345.\nPlano: 30\nTotal em créditos: 99'});
  await assert.rejects(previewBitPanelRenewal(config,subject(),f),{code:'RENEWAL_PROVIDER_QUOTE_MISMATCH'});
  assert.equal(f.calls.closes,1);assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);
});

test('expired snapshots, a disabled policy and unavailable close control fail closed without a financial action',async()=>{
  const old=fixture({beforeExpiry:'30/12/2026'});
  await assert.rejects(previewBitPanelRenewal(config,subject(),old),{code:'RENEWAL_PROVIDER_EXPIRATION_MISMATCH'});
  const off=fixture();await assert.rejects(previewBitPanelRenewal({...config,BITPANEL_AUTOMATIC_RENEWAL_POLICY:{...policy,enabled:false}},subject(),off),{code:'RENEWAL_PROVIDER_QUOTE_MISMATCH'});
  const close=fixture({missingExit:true});await assert.rejects(previewBitPanelRenewal(config,subject(),close),{code:'RENEWAL_PREVIEW_CLOSE_FAILED'});
  for(const f of [old,off,close])assert.equal(f.calls.finalClicks,0);
});

test('executor shares preparation, validates detail binding before reading a returned password and recognizes an already renewed list',async()=>{
  const live={...config,BITPANEL_MODE:'live',BITPANEL_BEFORE_RENEWAL_SUBMIT:async()=>({verified:true})};
  const good=fixture();const result=await renewInBitPanel(live,subject(),good);
  assert.equal(result.afterExpiry,'2027-01-31');assert.equal(good.calls.finalClicks,1);assert.equal(good.calls.passwordReads,1);
  for(const patch of [{afterId:'99999'},{afterUsername:'someone.else'}]) {
    const f=fixture(patch);await assert.rejects(renewInBitPanel(live,subject(),f),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
    assert.equal(f.calls.passwordReads,0);
  }
  const done=fixture({beforeExpiry:'31/01/2027'});const duplicate=await renewInBitPanel(live,subject(),done);
  assert.equal(duplicate.alreadyRenewed,true);assert.equal(done.calls.finalClicks,0);assert.equal(done.calls.passwordReads,0);assert.equal(done.calls.menus,0);
});

test('previews report unknown or insufficient credit capacity without preventing a twelve-month quote or obtaining an actuator',async()=>{
  for(const [patch,balance] of [
    [{balanceLabel:'Créditos disponíveis: 9'},{status:'verified',availableCredits:9,sufficient:false}],
    [{balanceLabel:'mdi-coin 9'},{status:'unverified',availableCredits:null,sufficient:null}],
    [{balanceLabels:['Saldo em créditos: 90','Créditos disponíveis: 90']},{status:'unverified',availableCredits:null,sufficient:null}]
  ]) {
    const f=fixture(patch);const result=await previewBitPanelRenewal(config,subject('annual',12),f);
    assert.equal(result.prepared,true);assert.equal(result.quote.credits,12);assert.deepEqual(result.balance,balance);
    assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.closes,1);
  }
});

test('a real executor rejects unverified or insufficient credits before any financial action',async()=>{
  const live={...config,BITPANEL_MODE:'live',BITPANEL_BEFORE_RENEWAL_SUBMIT:async()=>({verified:true})};
  for(const [patch,code] of [
    [{balanceLabel:'mdi-coin 90'},'RENEWAL_PROVIDER_BALANCE_UNVERIFIED'],
    [{balanceLabels:['Saldo em créditos: 90','Créditos disponíveis: 90']},'RENEWAL_PROVIDER_BALANCE_UNVERIFIED'],
    [{balanceLabel:'Créditos disponíveis: 9'},'RENEWAL_PROVIDER_INSUFFICIENT_CREDITS'],
    [{balanceLabel:'Saldo de créditos: 0'},'RENEWAL_PROVIDER_INSUFFICIENT_CREDITS']
  ]) {
    const f=fixture(patch);await assert.rejects(renewInBitPanel(live,subject('annual',12),f),{code});
    assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.screenshots,0);assert.equal(f.calls.closes,1);
  }
  const enough=fixture({balanceLabel:'Saldo em créditos: 12'});
  await renewInBitPanel(live,subject('annual',12),enough);assert.equal(enough.calls.finalClicks,1);
});

test('credit capacity and the quote are checked again immediately before the final binding check and actuator',async()=>{
  let verified=0;
  const live={...config,BITPANEL_MODE:'live',BITPANEL_BEFORE_RENEWAL_SUBMIT:async()=>{verified++;return{verified:true};}};
  for(const [patch,code] of [
    [{balanceAfter:'Créditos disponíveis: 0'},'RENEWAL_PROVIDER_INSUFFICIENT_CREDITS'],
    [{balanceAfter:'unlabelled 90'},'RENEWAL_PROVIDER_BALANCE_UNVERIFIED'],
    [{quote:calls=>`Renovar lista #12345.\nValor da unidade: R$ 30,00\nPlano: 30\nTotal de conexões: 1\nQuantidade de meses: 1\nTotal em créditos: ${calls.screenshots?2:1}\nValor total: R$ 30,00`},'RENEWAL_PROVIDER_QUOTE_MISMATCH']
  ]) {
    const f=fixture(patch);await assert.rejects(renewInBitPanel(live,subject(),f),{code});
    assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.closes,1);
  }
  assert.equal(verified,0);
  const f=fixture();const result=await renewInBitPanel({...live,BITPANEL_BEFORE_RENEWAL_SUBMIT:async()=>{
    assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.balanceReads,2);assert.equal(f.calls.screenshots,1);
    return{verified:true};
  }},subject(),f);
  assert.equal(result.afterExpiry,'2027-01-31');assert.equal(f.calls.finalClicks,1);
});

test('automatic execution requires a successful own-binding callback, but the preview never invokes it',async()=>{
  const live={...config,BITPANEL_MODE:'live'};
  for(const callback of [undefined,async()=>({verified:false}),async()=>undefined,async()=>{throw Error('secret dynamic detail');}]) {
    const f=fixture();await assert.rejects(renewInBitPanel({...live,BITPANEL_BEFORE_RENEWAL_SUBMIT:callback},subject(),f),
      error=>error.code==='RENEWAL_BINDING_UNVERIFIED'&&!error.message.includes('secret'));
    assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);assert.equal(f.calls.closes,1);
  }
  const preview=fixture();await previewBitPanelRenewal({...config,BITPANEL_BEFORE_RENEWAL_SUBMIT:async()=>{
    assert.fail('preview must not execute the binding callback');
  }},subject(),preview);
  assert.equal(preview.calls.finalClicks,0);
});

test('a human-approved renewal still requires labelled sufficient balance and an intact quote',async()=>{
  const live={...config,BITPANEL_MODE:'live',BITPANEL_AUTOMATIC_RENEWAL_POLICY:null};
  const human={...subject(),automatic_renewal:false};
  const good=fixture();await renewInBitPanel(live,human,good);assert.equal(good.calls.finalClicks,1);
  const unknown=fixture({balanceLabel:'mdi-coin 90'});
  await assert.rejects(renewInBitPanel(live,human,unknown),{code:'RENEWAL_PROVIDER_BALANCE_UNVERIFIED'});
  assert.equal(unknown.calls.finalClicks,0);
  const changed=fixture({quote:'Renovar lista #99999.\nTotal em créditos: 1'});
  await assert.rejects(renewInBitPanel(live,human,changed),{code:'RENEWAL_PROVIDER_QUOTE_MISMATCH'});
  assert.equal(changed.calls.finalClicks,0);
});

test('preview sanitizes unexpected provider errors and does not depend on the execution mode being enabled',async()=>{
  await assert.rejects(previewBitPanelRenewal(config,subject(),{withSession:async()=>{throw Error('synthetic-secret unexpected DOM content');}}),error=>error.code==='RENEWAL_PREVIEW_UNAVAILABLE'&&!error.message.includes('synthetic-secret'));
  const f=fixture();await assert.rejects(previewBitPanelRenewal(config,{...subject(),charge_stage:'new_sale'},f),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
  assert.equal(f.calls.finalClicks,0);
});

test('a provider Aguarde dialog transitions to the form and options hydrate before exact selection',async()=>{
  const f=fixture({loadingMs:2400,optionDelayMs:800,validityDelayMs:600});
  const result=await previewBitPanelRenewal(config,subject(),f);
  assert.equal(result.prepared,true);assert.equal(result.quote.months,1);
  assert.equal(f.calls.menus,1);assert.equal(f.calls.optionClicks,2);assert.equal(f.calls.closes,1);
  assert.ok(f.calls.waitMs>=4700);
  assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);
});

test('a permanent Aguarde reaches its bounded timeout and only closes the nonfinancial Fechar control',async()=>{
  const f=fixture({permanentLoading:true});
  await assert.rejects(previewBitPanelRenewal(config,subject(),f),{code:'RENEWAL_PREVIEW_UNAVAILABLE'});
  assert.ok(f.calls.waitMs>=12000);assert.ok(f.calls.waitMs<=12700);
  assert.equal(f.calls.closes,1);assert.equal(f.calls.optionClicks,0);
  assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);assert.equal(f.calls.screenshots,0);
});

test('preexisting, duplicate and unrecognized dialogs are blocked before any option or actuator',async()=>{
  for(const patch of [{preexistingDialog:true},{duplicateDialogs:true},{unknownDialog:true},{duplicatePlan:true},
    {permanentLoading:true,loadingFields:1}]) {
    const f=fixture(patch);
    await assert.rejects(previewBitPanelRenewal(config,subject(),f),error=>
      error.code==='RENEWAL_PREVIEW_UNAVAILABLE'&&!error.message.includes('private'));
    assert.equal(f.calls.optionClicks,0);assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);
    if(patch.preexistingDialog)assert.equal(f.calls.menus,0);
    if(patch.unknownDialog || patch.loadingFields)assert.equal(f.calls.closes,0);
  }
});

test('source changes during form loading or option hydration cannot select an option or close a foreign dialog',async()=>{
  for(const patch of [{redirectOnMenu:'https://foreign.example/list'},
    {loadingMs:2000,redirectOnWait:'https://bitpanel.vip/login'},
    {optionDelayMs:800,redirectOnWait:'https://foreign.example/list'}]) {
    const f=fixture(patch);
    await assert.rejects(previewBitPanelRenewal(config,subject(),f),{code:patch.redirectOnWait?.includes('/login')?
      'BITPANEL_READ_REAUTH_REQUIRED':'BITPANEL_READ_LINK_UNVERIFIED'});
    assert.equal(f.calls.optionClicks,0);assert.equal(f.calls.closes,0);assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);
  }
});

test('renewal selection requires a unique visible exact option and cannot choose a substring month or wrong price',async()=>{
  for(const patch of [{planLabels:['30, R$30,00','30, R$30,00']},{planLabels:['30, R$31,00']},{hiddenOptions:true}]) {
    const f=fixture(patch);await assert.rejects(previewBitPanelRenewal(config,subject(),f),{code:'RENEWAL_PREVIEW_UNAVAILABLE'});
    assert.equal(f.calls.optionClicks,0);assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);
  }
  const wrongMonth=fixture({monthLabels:['13 Meses']});
  await assert.rejects(previewBitPanelRenewal(config,subject('quarterly',3),wrongMonth),{code:'RENEWAL_PREVIEW_UNAVAILABLE'});
  assert.equal(wrongMonth.calls.optionClicks,1);assert.equal(wrongMonth.calls.finalLookups,0);assert.equal(wrongMonth.calls.finalClicks,0);
});

test('cleanup failures retain the primary fixed failure and ambiguous close controls never click',async()=>{
  const badQuote=fixture({quote:'private invalid quote',missingExit:true});
  await assert.rejects(previewBitPanelRenewal(config,subject(),badQuote),error=>
    error.code==='RENEWAL_PROVIDER_QUOTE_MISMATCH'&&error.cleanupCode==='RENEWAL_PREVIEW_CLOSE_FAILED'&&!error.message.includes('private'));
  const stuck=fixture({permanentLoading:true,closeThrows:true});
  await assert.rejects(previewBitPanelRenewal(config,subject(),stuck),error=>
    error.code==='RENEWAL_PREVIEW_UNAVAILABLE'&&error.cleanupCode==='RENEWAL_PREVIEW_CLOSE_FAILED'&&!error.message.includes('private'));
  const ambiguous=fixture({extraClose:true});
  await assert.rejects(previewBitPanelRenewal(config,subject(),ambiguous),{code:'RENEWAL_PREVIEW_CLOSE_FAILED'});
  assert.equal(ambiguous.calls.closes,0);
  for(const f of [badQuote,stuck,ambiguous]) {assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);}
});

test('one hundred option nodes use bounded DOM batches and only read the two selected candidates via individual RPCs',async()=>{
  const planLabels=[...Array.from({length:99},(_,index)=>`${index+100}, R$30,00`),'30, R$30,00'];
  const monthLabels=Array.from({length:12},(_,index)=>`${index+1} ${index===0?'Mês':'Meses'}`);
  const f=fixture({planLabels,monthLabels});
  const result=await previewBitPanelRenewal(config,subject(),f);
  assert.equal(result.prepared,true);assert.equal(result.quote.months,1);
  assert.equal(f.calls.optionBatches,4);assert.equal(f.calls.optionReads,2);assert.equal(f.calls.optionVisibilityReads,2);
  assert.equal(f.calls.optionCountReads,0);assert.equal(f.calls.optionClicks,2);
  assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);
});

test('reordered, duplicated, hidden or relabelled candidates between snapshots cannot click any option',async()=>{
  for(const patch of [{reorderAfterBatch:true},{duplicateAfterBatch:true},{hideAfterBatch:true},{changeCandidateRead:true}]) {
    const f=fixture(patch);
    await assert.rejects(previewBitPanelRenewal(config,subject(),f),{code:'RENEWAL_PREVIEW_UNAVAILABLE'});
    assert.equal(f.calls.optionClicks,0);assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);
    assert.equal(f.calls.closes,1);
  }
});

test('oversized option batches and source changes while batching cannot authorize any selection',async()=>{
  for(const [patch,code] of [[{planLabels:Array.from({length:101},()=> '30, R$30,00')},'RENEWAL_PREVIEW_UNAVAILABLE'],
    [{redirectAfterBatch:'https://foreign.example/list'},'BITPANEL_READ_LINK_UNVERIFIED']]) {
    const f=fixture(patch);await assert.rejects(previewBitPanelRenewal(config,subject(),f),{code});
    assert.equal(f.calls.optionClicks,0);assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);
  }
});

test('the safe close click and disappearance share a total five-second budget',async t=>{
  let now=0;t.mock.method(Date,'now',()=>now);
  const f=fixture({onCloseClick:()=>{now+=4000;}});
  const result=await previewBitPanelRenewal(config,subject(),f);
  assert.equal(result.prepared,true);assert.equal(f.calls.closeClickTimeout,5000);assert.equal(f.calls.closeWaitTimeout,1000);
  assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);
});

test('field opening and exact option selection share the same remaining five-second deadline',async t=>{
  let now=0;t.mock.method(Date,'now',()=>now);
  const f=fixture({onFieldClick:()=>{now+=4000;}});
  const result=await previewBitPanelRenewal(config,subject(),f);
  assert.equal(result.prepared,true);assert.equal(f.calls.optionClicks,2);
  assert.deepEqual(f.calls.fieldClickTimeouts,[5000,5000]);assert.deepEqual(f.calls.optionClickTimeouts,[1000,1000]);
  assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);
});

test('late last modal RPCs expire the field or option budget before another click can start',async t=>{
  let now=0;t.mock.method(Date,'now',()=>now);
  const field=fixture({onDialogVisible:calls=>{if(calls.fieldVisibilityReads===2 && !calls.fieldClickAttempts)now=6000;}});
  await assert.rejects(previewBitPanelRenewal(config,subject(),field),{code:'RENEWAL_PREVIEW_UNAVAILABLE'});
  assert.equal(field.calls.fieldClickAttempts,0);assert.equal(field.calls.optionClickAttempts,0);
  now=0;
  const option=fixture({onDialogCount:calls=>{if(calls.optionReads===1)now=6000;}});
  await assert.rejects(previewBitPanelRenewal(config,subject(),option),{code:'RENEWAL_PREVIEW_UNAVAILABLE'});
  assert.equal(option.calls.fieldClickAttempts,1);assert.equal(option.calls.optionClickAttempts,0);
  for(const f of [field,option]) {assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);}
});

test('obstructed field and option clicks receive only the remaining budget and expose a fixed failure',async t=>{
  let now=0;t.mock.method(Date,'now',()=>now);
  const field=fixture({fieldClickThrows:true,onFieldVisible:calls=>{if(calls.fieldVisibilityReads===3)now=2000;}});
  await assert.rejects(previewBitPanelRenewal(config,subject(),field),error=>
    error.code==='RENEWAL_PREVIEW_UNAVAILABLE'&&!error.message.includes('private'));
  assert.deepEqual(field.calls.fieldClickTimeouts,[3000]);assert.equal(field.calls.optionClickAttempts,0);
  now=0;
  const option=fixture({optionClickThrows:true,onFieldClick:()=>{now=4000;}});
  await assert.rejects(previewBitPanelRenewal(config,subject(),option),error=>
    error.code==='RENEWAL_PREVIEW_UNAVAILABLE'&&!error.message.includes('private'));
  assert.deepEqual(option.calls.optionClickTimeouts,[1000]);assert.equal(option.calls.optionClicks,0);
  for(const f of [field,option]) {assert.equal(f.calls.finalLookups,0);assert.equal(f.calls.finalClicks,0);assert.equal(f.calls.passwordReads,0);}
});
