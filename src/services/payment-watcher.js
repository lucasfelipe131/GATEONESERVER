import { createBusinessEvent } from '../core/events.js';
import { appendOutboxEvent } from '../core/outbox.js';
import {
  isTrustedPaymentConfirmation,
  normalizeProviderPayment,
  reconcilePayment
} from '../core/billing-operations.js';

const PAYMENT_EVENTS = Object.freeze({
  CREATED: 'payment.created',
  PENDING: 'payment.pending',
  CONFIRMED: 'payment.confirmed',
  FAILED: 'payment.failed',
  EXPIRED: 'payment.expired',
  CANCELLED: 'payment.cancelled',
  REFUNDED: 'payment.refunded'
});

export class PaymentWatcher {
  constructor({ db, providerName, logger = null }) {
    this.db = db;
    this.providerName = String(providerName).toLowerCase();
    this.logger = logger;
  }

  async observe(rawEvent, {
    source = 'WEBHOOK',
    providerVerified = false,
    administrativeActor = null,
    correlationId
  } = {}) {
    const event = normalizeProviderPayment({ ...rawEvent, provider: this.providerName });
    const trustedConfirmation = event.status !== 'CONFIRMED' || isTrustedPaymentConfirmation({
      source: source === 'ADMIN' ? 'ADMIN' : 'PROVIDER',
      providerVerified,
      administrativeActor
    });
    const result = await this.db.transaction(async (client) => {
      const stored = await client.query(
        `INSERT INTO payment_provider_events
          (provider, external_event_id, external_payment_id, source, normalized_status,
           amount_cents, currency, observed_at, signature_verified, payload, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         ON CONFLICT (provider, external_event_id) DO NOTHING
         RETURNING id`,
        [event.provider, event.external_event_id, event.external_payment_id, source,
          event.status, event.amount_cents, event.currency, event.observed_at,
          providerVerified, JSON.stringify(event.payload), correlationId]
      );
      if (!stored.rowCount) return { duplicate: true, changed: false };
      const paymentResult = await client.query(
        `SELECT * FROM payments
          WHERE provider = $1 AND external_payment_id = $2
          FOR UPDATE`,
        [event.provider, event.external_payment_id]
      );
      const payment = paymentResult.rows[0];
      if (!payment) {
        await client.query(
          `UPDATE payment_provider_events SET processing_error = 'PAYMENT_NOT_FOUND'
            WHERE id = $1`, [stored.rows[0].id]
        );
        return { duplicate: false, changed: false, review: 'PAYMENT_NOT_FOUND' };
      }
      const reconciliation = reconcilePayment({ internal: payment, external: event });
      if (!trustedConfirmation || ['DIVERGENT', 'REQUIRES_REVIEW'].includes(reconciliation.status)) {
        const reason = !trustedConfirmation ? 'UNTRUSTED_CONFIRMATION_SOURCE' : reconciliation.reason;
        await client.query(
          `UPDATE payments
              SET reconciliation_status = 'REQUIRES_REVIEW', review_reason = $2,
                  last_external_event_id = $3, provider_observed_at = $4, updated_at = now()
            WHERE id = $1`,
          [payment.id, reason, event.external_event_id, event.observed_at]
        );
        await appendOutboxEvent(client, createBusinessEvent({
          eventType: 'payment.review_required', correlationId,
          actor: { type: 'SERVICE', id: `payment-watcher:${event.provider}` },
          subject: { type: 'payment', id: payment.id },
          payload: { customer_id: payment.customer_id, reason }
        }));
        return { duplicate: false, changed: false, review: reason };
      }
      const changed = payment.status !== event.status;
      await client.query(
        `UPDATE payments
            SET status = $2, reconciliation_status = $3, review_reason = NULL,
                last_external_event_id = $4, provider_observed_at = $5,
                confirmed_at = CASE WHEN $2 = 'CONFIRMED' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
                updated_at = now()
          WHERE id = $1`,
        [payment.id, event.status, 'MATCHED',
          event.external_event_id, event.observed_at]
      );
      await client.query(
        `UPDATE payment_provider_events SET payment_id = $2, processed_at = now()
          WHERE id = $1`, [stored.rows[0].id, payment.id]
      );
      if (changed) {
        await appendOutboxEvent(client, createBusinessEvent({
          eventType: PAYMENT_EVENTS[event.status], correlationId,
          actor: { type: 'SERVICE', id: `payment-watcher:${event.provider}` },
          subject: { type: 'payment', id: payment.id },
          payload: {
            customer_id: payment.customer_id,
            subscription_id: payment.subscription_id,
            amount_cents: event.amount_cents,
            currency: event.currency,
            external_event_id: event.external_event_id
          }
        }));
      }
      return { duplicate: false, changed, payment_id: payment.id, status: event.status };
    });
    this.logger?.info?.({
      payment_id: result.payment_id || null,
      provider: event.provider,
      correlation_id: correlationId,
      state: event.status,
      result: result.review || (result.duplicate ? 'DUPLICATE_PREVENTED' : result.changed ? 'CHANGED' : 'UNCHANGED')
    }, 'Evento financeiro normalizado pelo Payment Watcher');
    return result;
  }
}
