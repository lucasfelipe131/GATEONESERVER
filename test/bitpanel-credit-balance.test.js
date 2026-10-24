import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBitPanelCreditBalance, readBitPanelCreditBalance } from '../src/integrations/bitpanel.js';

test('only an explicit whole available-credit label with an integer identifies a balance',()=>{
  assert.equal(parseBitPanelCreditBalance('Créditos disponíveis: 9'),9);
  assert.equal(parseBitPanelCreditBalance('Saldo em créditos: 90'),90);
  assert.equal(parseBitPanelCreditBalance('Saldo de créditos:\n0'),0);
  assert.equal(parseBitPanelCreditBalance('  CRÉDITOS DISPONÍVEIS:\u00a012  '),12);
  for(const text of [null,9,'9','mdi-coin 9','Créditos: 9','Total em créditos: 9','R$ 90,00',
    'Saldo em créditos: -1','Saldo em créditos: 9.5','Saldo em créditos: 9,5','Saldo em créditos: 1e3',
    'Saldo em créditos: 09','Saldo em créditos: 9007199254740992','Saldo em créditos: 9\nCréditos disponíveis: 90',
    'Saldo em créditos: 9 pendentes','Saldo em créditos: 9\u202e','Saldo em créditos: 9<script>'])
    assert.equal(parseBitPanelCreditBalance(text),null);
});

function page(labels,{url='https://bitpanel.vip/list',changedUrl}={}) {
  let reads=0;
  return {url:()=>changedUrl&&reads?changedUrl:url,getByText:pattern=>({
    count:async()=>labels.filter(item=>pattern.test(item.text)).length,
    nth:index=>{
      const item=labels.filter(item=>pattern.test(item.text))[index];
      return {isVisible:async()=>item.visible!==false,innerText:async()=>{reads++;return item.text;}};
    }
  })};
}

test('visible balance identity must be unique, hidden duplicates and unlabelled icons cannot authorize it',async()=>{
  assert.equal(await readBitPanelCreditBalance(page([{text:'Créditos disponíveis: 90'}]),'https://bitpanel.vip'),90);
  assert.equal(await readBitPanelCreditBalance(page([{text:'mdi-coin 90'}]),'https://bitpanel.vip'),null);
  assert.equal(await readBitPanelCreditBalance(page([{text:'Créditos disponíveis: 90'},{text:'Saldo em créditos: 9'}]),'https://bitpanel.vip'),null);
  assert.equal(await readBitPanelCreditBalance(page([{text:'Créditos disponíveis: 90'},{text:'Saldo em créditos: 9',visible:false}]),'https://bitpanel.vip'),90);
  assert.equal(await readBitPanelCreditBalance(page([{text:'Créditos disponíveis: 90',visible:false}]),'https://bitpanel.vip'),null);
});

test('balance provenance stays on the verified authenticated list page before and after reading',async()=>{
  for(const url of ['https://other.net/list','https://bitpanel.vip/list?account=other','https://bitpanel.vip/list#other','https://bitpanel.vip/'])
    await assert.rejects(readBitPanelCreditBalance(page([{text:'Créditos disponíveis: 90'}],{url}),'https://bitpanel.vip'),{code:'BITPANEL_READ_LINK_UNVERIFIED'});
  await assert.rejects(readBitPanelCreditBalance(page([{text:'Créditos disponíveis: 90'}],{changedUrl:'https://bitpanel.vip/login'}),'https://bitpanel.vip'),{code:'BITPANEL_READ_REAUTH_REQUIRED'});
  assert.equal(await readBitPanelCreditBalance({url:()=> 'https://bitpanel.vip/list',getByText:()=>{throw Error('synthetic private error');}},'https://bitpanel.vip'),null);
});
