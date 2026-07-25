import test from 'node:test';
import assert from 'node:assert/strict';
import { hmacSha256, maskPhone, normalizePhone, safeEqual } from '../src/security.js';
import { verifyMercadoPagoWebhook } from '../src/integrations/mercadopago.js';

test('normaliza telefone brasileiro', () => {
  assert.equal(normalizePhone('(55) 99999-9999'), '5555999999999');
  assert.equal(normalizePhone('+55 55 99999-9999'), '5555999999999');
  assert.throws(() => normalizePhone('123'));
});

test('mascara telefone antes de exibir no painel', () => {
  assert.equal(maskPhone('5555999999999'), '5555•••••9999');
});

test('comparação segura distingue assinaturas', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('valida assinatura do webhook do Mercado Pago', () => {
  const secret = 'segredo-webhook';
  const dataId = '12345';
  const requestId = 'req-1';
  const ts = '1784916514';
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const signature = `ts=${ts},v1=${hmacSha256(secret, manifest)}`;
  const valid = verifyMercadoPagoWebhook({
    config: { MERCADOPAGO_WEBHOOK_SECRET: secret, PAYMENT_MODE: 'live' },
    signature,
    requestId,
    dataId
  });
  assert.equal(valid, true);
});
