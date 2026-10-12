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
  const calls={finalLookups:0,finalClicks:0,passwordReads:0,closes:0,screenshots:0,menus:0,urls:[]};
  let currentUrl,dialogVisible=false,dropdown,selectedMonths=1,selectedPlan='30';
  const beforeExpiry=options.beforeExpiry || '31/12/2026';
  const rows=options.rows || [['client.one',beforeExpiry,'Gate One Pro Server','12345','Ativa']];
  const one = text => ({count:async()=>1,first(){return this;},waitFor:async()=>{},innerText:async()=>text});
  const search={isVisible:async()=>true,fill:async value=>assert.equal(value,'client.one')};
  const empty={count:async()=>0};
  const dialog={
    count:async()=>dialogVisible?1:0,isVisible:async()=>dialogVisible,
    waitFor:async({state})=>assert.equal(dialogVisible,state==='visible'),
    innerText:async()=>options.quote || `Renovar lista #12345.\nValor da unidade: R$ 30,00\nPlano: ${selectedPlan}\nTotal de conexões: 1\nQuantidade de meses: ${selectedMonths}\nTotal em créditos: ${selectedMonths}\nValor total: R$ ${30*selectedMonths},00\nSAIR\nRENOVAR`,
    getByRole:(_role,{name})=>{
      if(name instanceof RegExp && name.test('Selecione o plano'))return{count:async()=>1,click:async()=>{dropdown='plan';}};
      if(name instanceof RegExp && name.test('Selecione a validade'))return{count:async()=>1,click:async()=>{dropdown='months';}};
      if(name instanceof RegExp && name.test('SAIR'))return{count:async()=>options.missingExit?0:1,click:async()=>{calls.closes++;dialogVisible=false;}};
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
    waitForTimeout:async()=>{},screenshot:async()=>{calls.screenshots++;},
    getByLabel:()=>({count:async()=>1,nth:()=>search}),
    getByText:pattern=>one(pattern.source.includes('Usuário')?'Usuário:':pattern.source.includes('Senha')?'Senha:':'Data de validade:'),
    getByRole:(role,{name})=>{
      if(role==='menuitem')return{click:async()=>{assert.equal(name,'Renovar');calls.menus++;dialogVisible=true;}};
      assert.equal(name,'Next page');return{count:async()=>1,isEnabled:async()=>Boolean(options.next)};
    },
    locator:selector=>{
      if(selector==='table tbody')return{waitFor:async()=>{}};
      if(selector==='li')return{filter:({hasText})=>{
        if(hasText.test('Usuário:'))return one(`Usuário: ${calls.finalClicks?(options.afterUsername || 'client.one'):(options.beforeUsername || 'client.one')}`);
        if(hasText.test('Senha:'))return{...one('Senha: synthetic-secret'),innerText:async()=>{calls.passwordReads++;return'Senha: synthetic-secret';}};
        return one(`Data de validade: ${calls.finalClicks?'31/01/2027':beforeExpiry}`);
      }};
      if(selector==='table thead th')return{allInnerTexts:async()=>['Usuário','Validade','Proprietário','ID','Estado']};
      if(selector==='table tbody tr')return{count:async()=>rows.length,nth:index=>({locator:()=>({count:async()=>rows[index].length,nth:cell=>one(rows[index][cell])})})};
      if(selector==='.v-dialog--active')return dialog;
      if(selector.startsWith('i[title='))return{count:async()=>1,click:async()=>{}};
      if(selector.startsWith('[role="option"]')) {
        const labels=dropdown==='plan'?['130, R$30,00','30, R$30,00']:['1 Mês','3 Meses','6 Meses','12 Meses'];
        return{count:async()=>labels.length,nth:index=>({isVisible:async()=>true,innerText:async()=>labels[index],click:async()=>{
          if(dropdown==='months')selectedMonths=Number(labels[index].match(/^\d+/)[0]);
          else selectedPlan=labels[index].match(/^\d+/)[0];
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
  const live={...config,BITPANEL_MODE:'live'};
  const good=fixture();const result=await renewInBitPanel(live,subject(),good);
  assert.equal(result.afterExpiry,'2027-01-31');assert.equal(good.calls.finalClicks,1);assert.equal(good.calls.passwordReads,1);
  for(const patch of [{afterId:'99999'},{afterUsername:'someone.else'}]) {
    const f=fixture(patch);await assert.rejects(renewInBitPanel(live,subject(),f),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
    assert.equal(f.calls.passwordReads,0);
  }
  const done=fixture({beforeExpiry:'31/01/2027'});const duplicate=await renewInBitPanel(live,subject(),done);
  assert.equal(duplicate.alreadyRenewed,true);assert.equal(done.calls.finalClicks,0);assert.equal(done.calls.passwordReads,0);assert.equal(done.calls.menus,0);
});

test('preview sanitizes unexpected provider errors and does not depend on the execution mode being enabled',async()=>{
  await assert.rejects(previewBitPanelRenewal(config,subject(),{withSession:async()=>{throw Error('synthetic-secret unexpected DOM content');}}),error=>error.code==='RENEWAL_PREVIEW_UNAVAILABLE'&&!error.message.includes('synthetic-secret'));
  const f=fixture();await assert.rejects(previewBitPanelRenewal(config,{...subject(),charge_stage:'new_sale'},f),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
  assert.equal(f.calls.finalClicks,0);
});
