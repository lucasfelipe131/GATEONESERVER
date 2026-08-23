function eventInvariant(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export function createPhase4EventHandlers({ db, renewalOrchestrator }) {
  async function loadRenewal(event) {
    const result = await db.query(
      `SELECT r.id AS renewal_id, r.payment_id, r.correlation_id,
              r.previous_expiration::text, r.requested_extension_months,
              p.customer_id, p.subscription_id, p.status AS payment_status,
              p.amount_cents, p.currency,
              s.customer_id AS subscription_customer_id,
              pl.price_cents AS expected_amount_cents
         FROM renewal_jobs r
         JOIN payments p ON p.id = r.payment_id
         JOIN subscriptions s ON s.id = p.subscription_id
         JOIN plans pl ON pl.id = s.plan_id
        WHERE ($1::uuid IS NULL OR r.id = $1::uuid)
          AND ($2::uuid IS NULL OR p.id = $2::uuid)
        ORDER BY r.created_at DESC LIMIT 1`,
      [event.subject.type === 'renewal' ? event.subject.id : null,
        event.subject.type === 'payment' ? event.subject.id : event.payload.payment_id || null]
    );
    const row = result.rows[0];
    eventInvariant(row, 'RENEWAL_NOT_FOUND_FOR_EVENT');
    eventInvariant(row.payment_status === 'CONFIRMED', 'PAYMENT_NOT_CONFIRMED');
    eventInvariant(row.customer_id === row.subscription_customer_id, 'CROSS_CUSTOMER_ISOLATION_VIOLATION');
    if (event.payload.customer_id) {
      eventInvariant(row.customer_id === event.payload.customer_id, 'EVENT_CUSTOMER_MISMATCH');
    }
    if (event.payload.subscription_id) {
      eventInvariant(row.subscription_id === event.payload.subscription_id, 'EVENT_SUBSCRIPTION_MISMATCH');
    }
    return row;
  }

  async function ensureSaga(event) {
    const row = await loadRenewal(event);
    await renewalOrchestrator.start({
      renewalId: row.renewal_id,
      customerId: row.customer_id,
      subscriptionId: row.subscription_id,
      payment: {
        id: row.payment_id,
        customer_id: row.customer_id,
        subscription_id: row.subscription_id,
        status: row.payment_status,
        amount_cents: row.amount_cents,
        currency: row.currency
      },
      previousExpiration: row.previous_expiration,
      requestedExtensionMonths: row.requested_extension_months,
      requestedBy: { type: 'SYSTEM', id: 'payment-watcher' },
      correlationId: event.correlation_id,
      causationId: event.event_id,
      expectedAmountCents: row.expected_amount_cents
    });
    return row;
  }

  return Object.freeze({
    'payment.confirmed': async (event) => {
      const saga = await ensureSaga(event);
      return { renewal_id: saga.renewal_id, state: 'READY' };
    },
    'renewal.ready': async (event) => {
      const saga = await ensureSaga(event);
      return renewalOrchestrator.run(saga.renewal_id);
    }
  });
}
