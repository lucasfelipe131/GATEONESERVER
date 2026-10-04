import { randomUUID } from 'node:crypto';
import { getMercadoPagoPayment, getMercadoPagoAccount } from '../integrations/mercadopago.js';
import { markPaymentApproved } from './billing.js';

const fail = code => Object.assign(new Error(code), { code });

export function moneyInCents(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw fail('INVALID_PROVIDER_AMOUNT');
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw fail('INVALID_PROVIDER_AMOUNT');
  return cents;
}

// Only an authenticated provider read can supply confirmation. A signed webhook
// identifies what to fetch; its body, checkout ID and customer proof are not money.
export async function reconcileMercadoPagoPayment({ db, config, paymentId,
  getPayment = getMercadoPagoPayment, getAccount = getMercadoPagoAccount }) {
  if (config.PAYMENT_MODE !== 'live') throw fail('LIVE_PAYMENT_REQUIRED');
  if (!/^\d{1,32}$/.test(String(paymentId))) throw fail('INVALID_PROVIDER_PAYMENT_ID');
  const payment = await getPayment(config, String(paymentId));
  if (String(payment.id) !== String(paymentId)) throw fail('PROVIDER_PAYMENT_ID_MISMATCH');
  if (payment.status !== 'approved') return { confirmed: false, status: payment.status };
  if (payment.live_mode !== true) throw fail('TEST_PAYMENT_REJECTED');
  if (payment.currency_id !== 'BRL') throw fail('PAYMENT_CURRENCY_MISMATCH');
  const amount = moneyInCents(payment.transaction_amount);
  const chargeId = String(payment.external_reference || '');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(chargeId)) throw fail('INVALID_CHARGE_REFERENCE');
  const account = await getAccount(config);
  if (!payment.collector_id || !account.id || String(payment.collector_id) !== String(account.id)) throw fail('PAYMENT_COLLECTOR_MISMATCH');
  return db.transaction(async client => {
    const result = await client.query(`SELECT ch.*, s.customer_id FROM charges ch
      JOIN subscriptions s ON s.id = ch.subscription_id WHERE ch.id = $1 FOR UPDATE OF ch`, [chargeId]);
    const charge = result.rows[0];
    if (!charge) throw fail('CHARGE_NOT_FOUND');
    if (charge.amount_cents !== amount) throw fail('PAYMENT_AMOUNT_MISMATCH');
    if (charge.status==='paid' && String(charge.mercado_pago_payment_id)!==String(payment.id)) throw fail('CHARGE_ALREADY_PAID_DIFFERENT_PAYMENT');
    if (['cancelled', 'rejected', 'expired'].includes(charge.status)) throw fail('CHARGE_CLOSED');
    const marked = await markPaymentApproved({ query: (sql, params) => client.query(sql, params),
      transaction: fn => fn(client) }, chargeId, { id: String(payment.id), provider: 'mercadopago',
      status: 'approved', date_approved: payment.date_approved || null,
      correlation_id: charge.correlation_id || randomUUID() });
    return { ...marked, confirmed: true, chargeId };
  });
}
