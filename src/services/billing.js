import {
  buildIdempotencyKey,
  classifyStage,
  dateOnlyInTimezone,
  renderChargeMessage
} from '../domain/billing.js';
import { audit } from '../audit.js';

export async function scanBilling(db, { now = new Date(), timezone = 'America/Sao_Paulo' } = {}) {
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
        AND p.active = true`
  );

  const stats = { checked: subscriptions.rowCount, created: 0, skipped: 0 };
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
       VALUES ($1, $2, 'awaiting_approval', $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        subscription.id,
        stage,
        subscription.price_cents,
        subscription.expires_on,
        idempotencyKey,
        message
      ]
    );
    if (inserted.rowCount) {
      stats.created += 1;
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
      `SELECT ch.*, s.customer_id, p.duration_months
         FROM charges ch
         JOIN subscriptions s ON s.id = ch.subscription_id
         JOIN plans p ON p.id = s.plan_id
        WHERE ch.id = $1
        FOR UPDATE`,
      [chargeId]
    );
    if (!charge.rows[0]) throw new Error('Cobrança não encontrada.');
    if (charge.rows[0].status === 'paid') return { duplicate: true, charge: charge.rows[0] };

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
    await client.query(
      `INSERT INTO renewal_jobs (charge_id, status)
       VALUES ($1, 'awaiting_approval')
       ON CONFLICT (charge_id) DO NOTHING`,
      [chargeId]
    );
    await client.query(
      `UPDATE leads SET status = 'converted', updated_at = now()
        WHERE whatsapp_e164 = (
          SELECT c.whatsapp_e164
            FROM subscriptions s JOIN customers c ON c.id = s.customer_id
           WHERE s.id = $1
        )`,
      [charge.rows[0].subscription_id]
    );
    return { duplicate: false, charge: updated.rows[0] };
  });
}
