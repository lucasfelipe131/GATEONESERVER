import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptSecret,
  encryptSecret,
  hmacSha256,
  maskPhone,
  normalizePhone,
  safeEqual,
  sanitizeForLog
} from '../src/security.js';
import {
  createCheckoutPreference,
  getMercadoPagoReadiness,
  verifyMercadoPagoWebhook
} from '../src/integrations/mercadopago.js';

test('normaliza telefone brasileiro', () => {
  assert.equal(normalizePhone('(55) 99999-9999'), '5555999999999');
  assert.equal(normalizePhone('+55 55 99999-9999'), '5555999999999');
  assert.equal(
    normalizePhone('5555999999999:12@s.whatsapp.net'),
    '5555999999999'
  );
  assert.equal(normalizePhone('55999999999@s.whatsapp.net'), '5555999999999');
  assert.throws(() => normalizePhone('123456789012345@lid'));
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

test('remove chaves de API antes da auditoria', () => {
  assert.deepEqual(
    sanitizeForLog({ OPENAI_API_KEY: 'sk-secret', OPENAI_MODEL: 'gpt-5.6' }),
    { OPENAI_API_KEY: '[PROTEGIDO]', OPENAI_MODEL: 'gpt-5.6' }
  );
});

test('protege e recupera a senha IPTV sem armazenar texto puro', () => {
  const encrypted = encryptSecret('senha-iptv-123', 'segredo-de-producao');
  assert.notEqual(encrypted, 'senha-iptv-123');
  assert.equal(decryptSecret(encrypted, 'segredo-de-producao'), 'senha-iptv-123');
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

test('só libera Mercado Pago com credenciais de produção completas', () => {
  const base = {
    PUBLIC_BASE_URL: 'https://gateoneserver-production.up.railway.app'
  };
  assert.equal(
    getMercadoPagoReadiness({
      ...base,
      MERCADOPAGO_ACCESS_TOKEN: 'TEST-123',
      MERCADOPAGO_WEBHOOK_SECRET: 'segredo'
    }).ready,
    false
  );
  assert.equal(
    getMercadoPagoReadiness({
      ...base,
      MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-123',
      MERCADOPAGO_WEBHOOK_SECRET: 'segredo'
    }).ready,
    true
  );
});

test('cria Checkout Pro com retorno ao Gate One Pro', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.external_reference, 'charge-1');
    assert.equal(payload.items[0].unit_price, 30);
    assert.equal(payload.payer.email, 'cliente@example.com');
    assert.match(payload.back_urls.success, /\/pagamento\?status=approved/);
    return {
      ok: true,
      status: 201,
      json: async () => ({
        id: 'pref-1',
        init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1'
      })
    };
  };
  try {
    const result = await createCheckoutPreference({
      PAYMENT_MODE: 'live',
      PUBLIC_BASE_URL: 'https://gateoneserver-production.up.railway.app',
      MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-production',
      MERCADOPAGO_WEBHOOK_SECRET: 'secret',
      MERCADOPAGO_NOTIFICATION_URL:
        'https://gateoneserver-production.up.railway.app/webhooks/mercadopago',
      MERCADOPAGO_PAYER_EMAIL: 'pagamentos@example.com'
    }, {
      id: 'charge-1',
      idempotency_key: 'idem-1',
      plan_code: 'monthly',
      plan_name: 'Mensal',
      duration_months: 1,
      amount_cents: 3000,
      customer_name: 'Cliente',
      customer_email: 'cliente@example.com',
      customer_phone: '5555999999999'
    });
    assert.equal(result.id, 'pref-1');
    assert.match(result.checkoutUrl, /mercadopago\.com\.br/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
