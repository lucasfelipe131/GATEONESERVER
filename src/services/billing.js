import { randomUUID } from 'node:crypto';
import {
  buildIdempotencyKey,
  classifyStage,
  dateOnlyInTimezone,
  renderChargeMessage
} from '../domain/billing.js';
import { audit } from '../audit.js';
import { createBusinessEvent } from '../core/events.js';
import { paymentIdempotencyKey, renewalIdempotencyKey } from '../core/idempotency.js';
import { appendOutboxEvent } from '../core/outbox.js';

export async function scanBilling(
  db,
  {
    now = new Date(),
    timezone = 'America/Sao_Paulo',
    initialStatus = 'awaiting_approval'
  } = {}
) {
  if (!['awaiting_approval', 'approved'].includes(initialStatus)) {
    throw new Error('Status inicial de cobrança inválido.');
  }
  const today = dateOnlyInTimezone(now, timezone);
  const subscriptions = await db.query(
    `SELECT s.id, s.expires_on::text, s.status, c.id AS customer_id, c.name,
            c.whatsapp_e164, c.consent_contact, c.opt_out_at,
            p.name AS plan_name, p.price_cents
       FROM subscriptions s
       JOIN customers c ON c.id = s.customer_id
       JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active', 'late')
        AND c.status NOT IN ('cancelled')
        AND c.automation_eligible = true
        AND p.active = true`
  );

  const stats = { checked: subscriptions.rowCount, created: 0, skipped: 0, chargeIds: [] };
  for (const subscription of subscriptions.rows) {
    const stage = classifyStage(subscription.expires_on, today);
    if (!stage || !subscription.consent_contact || subscription.opt_out_at) {
      stats.skipped += 1;
      continue;
    }

    const idempotencyKey = buildIdempotencyKey(
      subscription.id,
      stage,
      subscription.expires_on
    );
    const message = renderChargeMessage({
      name: subscription.name,
      planName: subscription.plan_name,
      expiresOn: subscription.expires_on,
      amountCents: subscription.price_cents,
      stage
    });
    const inserted = await db.query(
      `INSERT INTO charges
        (subscription_id, stage, status, amount_cents, due_on, idempotency_key, message_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        subscription.id,
        stage,
        initialStatus,
        subscription.price_cents,
        subscription.expires_on,
        idempotencyKey,
        message
      ]
    );
    if (inserted.rowCount) {
      stats.created += 1;
      stats.chargeIds.push(inserted.rows[0].id);
      await audit(db, {
        action: 'billing.charge_prepared',
        entityType: 'charge',
        entityId: inserted.rows[0].id,
        after: { stage, idempotencyKey }
      });
    } else {
      stats.skipped += 1;
    }
  }
  return stats;
}

export async function markPaymentApproved(db, chargeId, payment) {
  return db.transaction(async (client) => {
    const charge = await client.query(
      `SELECT ch.*, s.customer_id, s.bitpanel_list_id, p.duration_months
         FROM charges ch
         JOIN subscriptions s ON s.id = ch.subscription_id
         JOIN plans p ON p.id = COALESCE(ch.plan_id, s.plan_id)
        WHERE ch.id = $1
        FOR UPDATE`,
      [chargeId]
    );
    if (!charge.rows[0]) throw new Error('Cobrança não encontrada.');
    if (charge.rows[0].status === 'paid') {
      const existingJob = await client.query(
        `SELECT r.id, r.payment_id
           FROM renewal_jobs r WHERE r.charge_id = $1`,
        [chargeId]
      );
      return {
        duplicate: true,
        charge: charge.rows[0],
        renewalId: existingJob.rows[0]?.id || null,
        paymentId: existingJob.rows[0]?.payment_id || null
      };
    }

    const provider = String(
      payment?.provider || (String(payment?.id || '').startsWith('MANUAL-') ? 'manual' : 'mercadopago')
    ).toLowerCase();
    const externalPaymentId = String(payment?.id || '').trim();
    if (!externalPaymentId) throw new Error('Pagamento sem identificador externo.');
    const correlationId = charge.rows[0].correlation_id || payment?.correlation_id || randomUUID();
    const paymentKey = paymentIdempotencyKey(provider, externalPaymentId);
    const persistedPayment = await client.query(
      `INSERT INTO payments
        (customer_id, subscription_id, charge_id, provider, external_payment_id,
         amount_cents, currency, status, idempotency_key, correlation_id,
         provider_payload, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'BRL', 'CONFIRMED', $7, $8, $9::jsonb, now())
       ON CONFLICT (idempotency_key) DO UPDATE
         SET updated_at = payments.updated_at
       RETURNING id`,
      [
        charge.rows[0].customer_id,
        charge.rows[0].subscription_id,
        chargeId,
        provider,
        externalPaymentId,
        charge.rows[0].amount_cents,
        paymentKey,
        correlationId,
        JSON.stringify({
          status: payment?.status || 'approved',
          date_approved: payment?.date_approved || null
        })
      ]
    );
    const paymentId = persistedPayment.rows[0].id;
    const confirmedEvent = createBusinessEvent({
      eventType: 'payment.confirmed',
      correlationId,
      actor: { type: 'SERVICE', id: provider },
      subject: { type: 'payment', id: paymentId },
      payload: {
        customer_id: charge.rows[0].customer_id,
        subscription_id: charge.rows[0].subscription_id,
        charge_id: chargeId,
        amount_cents: charge.rows[0].amount_cents,
        currency: 'BRL'
      }
    });
    await appendOutboxEvent(client, confirmedEvent);

    const updated = await client.query(
      `UPDATE charges
          SET status = 'paid',
              mercado_pago_payment_id = COALESCE($2, mercado_pago_payment_id),
              paid_at = now(),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [chargeId, payment?.id ? String(payment.id) : null]
    );
    const renewalKey = renewalIdempotencyKey(
      charge.rows[0].customer_id,
      charge.rows[0].subscription_id,
      paymentId
    );
    const renewalJob = await client.query(
      `INSERT INTO renewal_jobs
        (charge_id, status, payment_id, core_status, previous_expiration,
         requested_extension_months, idempotency_key, correlation_id)
       VALUES ($1, 'awaiting_approval', $2, 'READY',
         (SELECT expires_on FROM subscriptions WHERE id = $3), $4, $5, $6)
       ON CONFLICT (charge_id) DO UPDATE
         SET payment_id = COALESCE(renewal_jobs.payment_id, EXCLUDED.payment_id),
             core_status = CASE
               WHEN renewal_jobs.core_status = 'COMPLETED' THEN renewal_jobs.core_status
               ELSE 'READY'
             END,
             idempotency_key = COALESCE(renewal_jobs.idempotency_key, EXCLUDED.idempotency_key),
             correlation_id = COALESCE(renewal_jobs.correlation_id, EXCLUDED.correlation_id),
             updated_at = now()
       RETURNING id`,
      [
        chargeId,
        paymentId,
        charge.rows[0].subscription_id,
        charge.rows[0].duration_months,
        renewalKey,
        correlationId
      ]
    );
    await appendOutboxEvent(client, createBusinessEvent({
      eventType: 'renewal.ready',
      correlationId,
      causationId: confirmedEvent.event_id,
      actor: { type: 'SYSTEM', id: 'gate-core' },
      subject: { type: 'renewal', id: renewalJob.rows[0].id },
      payload: {
        customer_id: charge.rows[0].customer_id,
        subscription_id: charge.rows[0].subscription_id,
        payment_id: paymentId
      }
    }));
    await client.query(
      `UPDATE leads SET status = 'converted', updated_at = now()
        WHERE whatsapp_e164 = (
          SELECT c.whatsapp_e164
            FROM subscriptions s JOIN customers c ON c.id = s.customer_id
           WHERE s.id = $1
        )`,
      [charge.rows[0].subscription_id]
    );
    await client.query(
      `UPDATE customers
          SET operational_stage = CASE
                WHEN $2 = 'new_sale' OR $3::text IS NULL THEN 'create_login'
                ELSE 'ready'
              END,
              updated_at = now()
        WHERE id = $1`,
      [
        charge.rows[0].customer_id,
        charge.rows[0].stage,
        charge.rows[0].bitpanel_list_id
      ]
    );
    return {
      duplicate: false,
      charge: updated.rows[0],
      renewalId: renewalJob.rows[0].id,
      paymentId
    };
  });
}
