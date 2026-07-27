import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSupportMessage,
  cleanCustomerName,
  detectCustomerIssue,
  isProbableCustomerName,
  resolveIntegrationPhone
} from '../src/services/customer-memory.js';

test('valida e normaliza o nome informado pelo cliente', () => {
  assert.equal(cleanCustomerName('  lucas   felipe de oliveira '), 'Lucas Felipe De Oliveira');
  assert.equal(isProbableCustomerName('Ana Paula'), true);
  assert.equal(isProbableCustomerName('MENU'), false);
  assert.equal(isProbableCustomerName('3'), false);
});

test('reconhece problemas comuns e produz orientação com continuidade', () => {
  const issue = detectCustomerIssue('A imagem fica travando e carregando toda hora');
  assert.equal(issue.category, 'buffering');
  const message = buildSupportMessage(issue, {
    first_reported_at: '2026-07-20T12:00:00.000Z'
  });
  assert.match(message, /atendimento anterior/i);
  assert.match(message, /roteador/i);
  assert.match(message, /ATENDENTE/);
});

test('não classifica uma escolha normal de pagamento como problema', () => {
  assert.equal(detectCustomerIssue('Quero o plano mensal e pagar por Pix'), null);
});

test('aceita o campo whatsapp usado pelas rotas de confirmação', () => {
  assert.equal(resolveIntegrationPhone({ whatsapp: '553586334218' }), '5535986334218');
  assert.equal(resolveIntegrationPhone({ phone: '5535986334218' }), '5535986334218');
});
