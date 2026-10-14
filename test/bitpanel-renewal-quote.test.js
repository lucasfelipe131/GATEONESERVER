import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBitPanelRenewalQuote, validateBitPanelRenewalQuote } from '../src/services/bitpanel-renewal-quote.js';

const quote = (months, credits = months, connections = 1, plan = '30') => `Renovar lista #5328287.\nValor da unidade: R$ 30,00\nPlano: ${plan}\nTotal de conexões: ${connections}\nQuantidade de meses: ${months}\nTotal em créditos: ${credits}\nValor total: R$ ${String(30 * months * connections)},00\nSAIR\nRENOVAR`;
const plans = Object.fromEntries([['monthly',1,3000],['quarterly',3,8500],['semiannual',6,15000],['annual',12,27000]].map(([code,months,price])=>[code,{durationMonths:months,creditCost:months,priceCents:price}]));
const policy = {enabled:true,planLabel:'30',unitPriceCents:3000,maxConnections:1,maxCreditsPerRenewal:12,plans};

test('live quote matches the four explicitly validated periods',()=>{
  for(const [code,mapping] of Object.entries(plans)) {
    const renewal={automatic_renewal:true,bitpanel_list_id:'5328287',plan_code:code,duration_months:mapping.durationMonths,expected_credit_cost:mapping.creditCost};
    assert.equal(validateBitPanelRenewalQuote(quote(mapping.durationMonths),renewal,policy).credits,mapping.creditCost);
  }
});
test('wrong credit, duration, connections, price or plan stops before an actuator',()=>{
  const renewal={automatic_renewal:true,bitpanel_list_id:'5328287',plan_code:'monthly',duration_months:1,expected_credit_cost:1};
  for(const text of [quote(1,2),quote(3),quote(1,1,2),quote(1,1,1,'35'),quote(1).replace('R$ 30,00','R$ 35,00'),'',quote(1).replace('Total em créditos: 1','Total em créditos: 0.5'),quote(1).replace('Total em créditos: 1','Total em créditos: 1e3'),quote(1)+'\nValor total: R$ 90,00',quote(1).replace('Valor total: R$ 30,00','Valor total: R$ 30,000'),quote(1).replace('#5328287','#5328288')]) {
    let actions=0;
    assert.throws(()=>{validateBitPanelRenewalQuote(text,renewal,policy);actions++;},/QUOTE_MISMATCH/);
    assert.equal(actions,0);
  }
});
test('missing or changed policy cannot authorize an automatic click',()=>{
  const renewal={automatic_renewal:true,bitpanel_list_id:'5328287',plan_code:'annual',duration_months:12,expected_credit_cost:12};
  for(const p of [null,{...policy,enabled:false},{...policy,maxCreditsPerRenewal:6},{...policy,plans:{}}]) assert.throws(()=>validateBitPanelRenewalQuote(quote(12),renewal,p),/QUOTE_MISMATCH/);
});
test('quote parser requires exact provider fields and supports Brazilian money',()=>{
  assert.deepEqual(parseBitPanelRenewalQuote(quote(12)),{listId:'5328287',planLabel:'30',months:12,connections:1,credits:12,unitPriceCents:3000,totalPriceCents:36000});
  assert.equal(validateBitPanelRenewalQuote('',{automatic_renewal:false},null),null);
});
