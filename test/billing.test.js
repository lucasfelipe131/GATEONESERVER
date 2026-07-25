import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdempotencyKey,
  classifyStage,
  dateOnlyInTimezone,
  daysBetween,
  renderChargeMessage
} from '../src/domain/billing.js';

test('classifica os quatro momentos de cobrança', () => {
  assert.equal(classifyStage('2026-08-28', '2026-08-25'), 'd-3');
  assert.equal(classifyStage('2026-08-25', '2026-08-25'), 'd0');
  assert.equal(classifyStage('2026-08-23', '2026-08-25'), 'd+2');
  assert.equal(classifyStage('2026-08-20', '2026-08-25'), 'd+5');
  assert.equal(classifyStage('2026-08-24', '2026-08-25'), null);
});

test('calcula dias com datas civis, sem variar por fuso', () => {
  assert.equal(daysBetween('2026-08-26', '2026-08-25'), 1);
  assert.equal(daysBetween('2026-08-24', '2026-08-25'), -1);
  assert.equal(dateOnlyInTimezone(new Date('2026-08-25T02:30:00Z'), 'America/Sao_Paulo'), '2026-08-24');
});

test('gera chave idempotente estável por assinatura, estágio e vencimento', () => {
  assert.equal(
    buildIdempotencyKey('sub-1', 'd-3', '2026-08-25'),
    'sub-1:d-3:2026-08-25'
  );
});

test('mensagem contém nome, plano, data e valor', () => {
  const message = renderChargeMessage({
    name: 'Lucas Felipe',
    planName: 'Mensal',
    expiresOn: '2026-08-25',
    amountCents: 3000,
    stage: 'd-3'
  });
  assert.match(message, /Lucas/);
  assert.match(message, /Mensal/);
  assert.match(message, /25\/08\/2026/);
  assert.match(message, /30,00/);
});

test('mensagem de nova venda informa cobrança e ativação após pagamento', () => {
  const message = renderChargeMessage({
    name: 'Lucas Felipe',
    planName: 'Anual',
    expiresOn: '2026-08-25',
    amountCents: 27000,
    stage: 'new_sale'
  });
  assert.match(message, /Anual/);
  assert.match(message, /270,00/);
  assert.match(message, /Após a confirmação do pagamento/);
});
