import assert from 'node:assert/strict';
import test from 'node:test';
import {
  avoidRepeatedResponse,
  evaluateMemoryCandidate,
  renderConversationCourtesy,
  renderConversationResponse,
  validateConversationResponse
} from '../src/core/conversation-responses.js';

test('identifica o assistente virtual sem fingir atendimento humano e sem solicitar dados pessoais', () => {
  for(const text of ['você é humano?','vc é uma IA?','estou falando com um robô?','quem está me atendendo?']) {
    const reply=renderConversationCourtesy(text);
    assert.match(reply,/assistente virtual da Gate One/);
    assert.doesNotMatch(reply,/qual.*nome|senha|login|CPF/i);
  }
  assert.equal(renderConversationCourtesy('você é humano? quero falar com atendente'),null);
});

test('agradecimento não confirma solução nem pagamento e varia sem enviar menu', () => {
  const first=renderConversationCourtesy('muito obrigado pela ajuda!');
  const second=renderConversationCourtesy('valeu',[{response_text:first}]);
  assert.notEqual(first,second);
  for(const reply of [first,second,renderConversationCourtesy('até mais')]) {
    assert.ok(reply.length<100);
    assert.doesNotMatch(reply,/resolvido|conclu[ií]d|pagamento|MENU/i);
    assert.equal(validateConversationResponse(reply,{payment_status:'PENDING',renewal_status:'PROCESSING'}).allowed,true);
  }
  for(const text of ['obrigado, mas não está funcionando','valeu, quero renovar mensal','obrigado e paguei'])
    assert.equal(renderConversationCourtesy(text),null);
});

test('status da assinatura é exibido em português e valores desconhecidos não vazam', () => {
  assert.match(renderConversationResponse({intent:'SUBSCRIPTION_QUERY',facts:{subscription_status:'active'}}),/status ativo/);
  const unknown=renderConversationResponse({intent:'SUBSCRIPTION_QUERY',facts:{subscription_status:'INTERNAL_PRIVATE_STATE'}});
  assert.match(unknown,/em atualização/);assert.doesNotMatch(unknown,/INTERNAL_PRIVATE_STATE/);
});

test('payment pending nunca permite afirmar confirmação', () => {
  const facts = { payment_status: 'PENDING', renewal_status: null, expiration: null, handoff_id: null };
  assert.equal(validateConversationResponse('Seu pagamento foi confirmado.', facts).allowed, false);
  assert.match(renderConversationResponse({ intent: 'PAYMENT_STATUS', facts }), /Ainda não identifiquei/i);
});

test('renewal processing e verifying nunca antecipam conclusão', () => {
  for (const state of ['PROCESSING', 'VERIFYING']) {
    const facts = { payment_status: 'CONFIRMED', renewal_status: state, expiration: null, handoff_id: null };
    const response = renderConversationResponse({ intent: 'RENEWAL_STATUS', facts });
    assert.doesNotMatch(response, /concluída|sucesso/i);
    assert.equal(validateConversationResponse('Renovado com sucesso.', facts).allowed, false);
  }
});

test('completed permite confirmação somente depois da verificação', () => {
  const facts = {
    payment_status: 'CONFIRMED', renewal_status: 'COMPLETED',
    expiration: '2026-09-30', handoff_id: null
  };
  const response = renderConversationResponse({ intent: 'RENEWAL_STATUS', facts });
  assert.match(response, /concluída e verificada/i);
  assert.equal(validateConversationResponse(response, facts).allowed, true);
});

test('expiration null não permite inventar data', () => {
  const facts = { expiration: null, payment_status: null, renewal_status: null, handoff_id: null };
  const response = renderConversationResponse({ intent: 'EXPIRATION_QUERY', facts });
  assert.match(response, /não.*inventar/i);
  assert.equal(validateConversationResponse('Seu vencimento é 30/09/2026.', facts).allowed, false);
});

test('handoff só pode ser afirmado com identificador confirmado', () => {
  const missing = { handoff_id: null };
  const confirmed = { handoff_id: '10000000-0000-4000-8000-000000000001' };
  assert.equal(validateConversationResponse('Registrei o atendimento para a equipe.', missing).allowed, false);
  assert.equal(validateConversationResponse('Registrei o atendimento para a equipe.', confirmed).allowed, true);
});

test('anti-repetition evita resposta idêntica recente', () => {
  const result = avoidRepeatedResponse('Pagamento ainda pendente.', [
    { direction: 'OUTBOUND', content: 'Pagamento ainda pendente.' }
  ]);
  assert.equal(result.repeated, true);
  assert.notEqual(result.text, 'Pagamento ainda pendente.');
});

test('consulta repetida conserva vencimento e estado oficiais em vez de pedir a pergunta novamente', () => {
  for(const facts of [{expiration:'2026-09-30',plan_name:'Mensal',subscription_status:'active',payment_status:'PENDING'},
    {expiration:'2026-09-30',plan_name:'Mensal',subscription_status:'active',payment_status:'PENDING',checkout_url:'https://www.mercadopago.com.br/synthetic'},
    {expiration:'2026-09-30',plan_name:'Mensal',subscription_status:'active',payment_status:'CONFIRMED',renewal_status:'VERIFYING'},
    {payment_status:'PENDING',renewal_status:null},{payment_status:'CONFIRMED',renewal_status:'VERIFYING'}]) {
    const text=renderConversationResponse({intent:facts.expiration?'EXPIRATION_QUERY':'PAYMENT_STATUS',facts});
    const repeated=avoidRepeatedResponse(text,[{direction:'OUTBOUND',content:text}],facts);
    assert.equal(repeated.repeated,true);assert.notEqual(repeated.text,text);
    assert.equal(validateConversationResponse(repeated.text,facts).allowed,true);
    if(facts.expiration)assert.match(repeated.text,/30\/09\/2026/);
    else assert.ok(repeated.text.includes(text));
    assert.doesNotMatch(repeated.text,/qual ponto|o que voce quer|O estado continua/i);
  }
});

test('cobrança repetida conserva o próprio link sem gerar nova solicitação',()=>{
  const facts={payment_status:'PENDING',checkout_url:'https://www.mercadopago.com.br/synthetic',payment_methods:['Pix','Boleto']};
  const text=renderConversationResponse({intent:'PAYMENT_REQUEST',facts});
  const repeated=avoidRepeatedResponse(text,[{direction:'OUTBOUND',content:text}],facts);
  assert.equal(repeated.repeated,true);assert.match(repeated.text,/mesmo link/);
  assert.ok(repeated.text.includes(facts.checkout_url));assert.equal(validateConversationResponse(repeated.text,facts).allowed,true);
});

test('memória nunca vira source of truth operacional', () => {
  assert.deepEqual(evaluateMemoryCandidate({ type: 'PAYMENT_STATUS' }), {
    action: 'DISCARD', reason: 'AUTHORITATIVE_STATE_NOT_MEMORY'
  });
  assert.deepEqual(evaluateMemoryCandidate({ type: 'PREFERENCE' }), {
    action: 'MEMORY_CANDIDATE', requires_validation: true
  });
});
