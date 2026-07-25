import { randomUUID } from 'node:crypto';
import { hmacSha256, safeEqual } from '../security.js';

const API_URL = 'https://api.mercadopago.com';

export function getMercadoPagoReadiness(config) {
  const token = String(config.MERCADOPAGO_ACCESS_TOKEN || '').trim();
  const webhookSecret = String(config.MERCADOPAGO_WEBHOOK_SECRET || '').trim();
  const notificationUrl =
    config.MERCADOPAGO_NOTIFICATION_URL ||
    (config.PUBLIC_BASE_URL ? `${config.PUBLIC_BASE_URL}/webhooks/mercadopago` : '');
  const productionToken = token.startsWith('APP_USR-') && !token.startsWith('TEST-');
  const missing = [];

  if (!token) missing.push('access_token');
  else if (!productionToken) missing.push('production_access_token');
  if (!webhookSecret) missing.push('webhook_secret');
  if (!notificationUrl) missing.push('notification_url');

  return {
    ready: missing.length === 0,
    accessToken: Boolean(token),
    productionToken,
    webhookSecret: Boolean(webhookSecret),
    notificationUrl: Boolean(notificationUrl),
    missing
  };
}

function requireLiveConfig(config) {
  const readiness = getMercadoPagoReadiness(config);
  if (!readiness.ready) {
    throw new Error(`Mercado Pago não está pronto para produção: ${readiness.missing.join(', ')}.`);
  }
}

export function verifyMercadoPagoWebhook({ config, signature, requestId, dataId }) {
  if (!config.MERCADOPAGO_WEBHOOK_SECRET) return config.PAYMENT_MODE !== 'live';
  const parts = Object.fromEntries(
    String(signature || '')
      .split(',')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
  );
  if (!parts.ts || !parts.v1 || !dataId) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId || ''};ts:${parts.ts};`;
  const expected = hmacSha256(config.MERCADOPAGO_WEBHOOK_SECRET, manifest);
  return safeEqual(expected, parts.v1);
}

export async function createPixPayment(config, charge) {
  if (config.PAYMENT_MODE === 'simulation') {
    return {
      id: `SIM-${randomUUID()}`,
      status: 'pending',
      qrCode: `PIX-DEMONSTRACAO-${charge.id}`,
      ticketUrl: null,
      expiration: new Date(Date.now() + config.PIX_EXPIRATION_MINUTES * 60_000).toISOString(),
      simulated: true
    };
  }

  requireLiveConfig(config);
  const notificationUrl =
    config.MERCADOPAGO_NOTIFICATION_URL ||
    (config.PUBLIC_BASE_URL ? `${config.PUBLIC_BASE_URL}/webhooks/mercadopago` : undefined);
  if (!notificationUrl) throw new Error('URL pública do webhook do Mercado Pago não configurada.');

  const response = await fetch(`${API_URL}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.MERCADOPAGO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': charge.idempotency_key
    },
    body: JSON.stringify({
      transaction_amount: charge.amount_cents / 100,
      description: `Gate One Pro - ${charge.plan_name}`,
      payment_method_id: 'pix',
      external_reference: charge.id,
      notification_url: notificationUrl,
      date_of_expiration: new Date(
        Date.now() + config.PIX_EXPIRATION_MINUTES * 60_000
      ).toISOString(),
      payer: {
        email: charge.customer_email || config.MERCADOPAGO_PAYER_EMAIL,
        first_name: charge.customer_name.split(/\s+/)[0]
      }
    })
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Mercado Pago recusou a cobrança (${response.status}): ${body.message || 'erro'}`);
  }
  const data = body.point_of_interaction?.transaction_data || {};
  return {
    id: String(body.id),
    status: body.status,
    qrCode: data.qr_code,
    qrCodeBase64: data.qr_code_base64,
    ticketUrl: data.ticket_url,
    expiration: body.date_of_expiration,
    simulated: false
  };
}

export async function getMercadoPagoPayment(config, paymentId) {
  requireLiveConfig(config);
  const response = await fetch(`${API_URL}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${config.MERCADOPAGO_ACCESS_TOKEN}` }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Não foi possível consultar o pagamento ${paymentId}.`);
  return body;
}
