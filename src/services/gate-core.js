import { createBusinessEvent } from '../core/events.js';
import { identityResolution, normalizeExternalIdentity } from '../core/identity.js';
import {
  lifecycleFromLegacyStatus,
  transitionCustomerLifecycle
} from '../core/lifecycle.js';
import { appendOutboxEvent } from '../core/outbox.js';

function coreError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, details });
}

export async function resolveIdentity(db, { type, value, provider = 'core' }) {
  const identityType = String(type || '').toUpperCase();
  const normalized = normalizeExternalIdentity(identityType, value);
  const normalizedProvider = String(provider || 'core').trim().toLowerCase();
  const linked = await db.query(
    `SELECT customer_id
       FROM customer_identities
      WHERE identity_type = $1
        AND provider = $2
        AND normalized_value = $3
      ORDER BY verified_at DESC NULLS LAST, created_at`,
    [identityType, normalizedProvider, normalized]
  );
  if (linked.rows.length) {
    return {
      ...identityResolution(linked.rows.map((row) => row.customer_id)),
      identity: { type: identityType, provider: normalizedProvider }
    };
  }

  let legacyQuery = null;
  let legacyParams = [normalized];
  if (['WHATSAPP', 'PHONE'].includes(identityType) && ['core', 'whatsapp'].includes(normalizedProvider)) {
    legacyQuery = `SELECT id AS customer_id FROM customers
      WHERE regexp_replace(COALESCE(whatsapp_e164, ''), '[^0-9]', '', 'g') = $1`;
  } else if (identityType === 'EMAIL' && normalizedProvider === 'core') {
    legacyQuery = `SELECT id AS customer_id FROM customers
      WHERE lower(trim(COALESCE(email, ''))) = $1`;
  } else if (identityType === 'LOGIN' && ['core', 'bitpanel'].includes(normalizedProvider)) {
    legacyQuery = `SELECT id AS customer_id FROM customers
      WHERE lower(trim(COALESCE(bitpanel_reference, ''))) = $1`;
  } else {
    legacyParams = [];
  }

  const legacy = legacyQuery ? await db.query(legacyQuery, legacyParams) : { rows: [] };
  return {
    ...identityResolution(legacy.rows.map((row) => row.customer_id)),
    identity: { type: identityType, provider: normalizedProvider }
  };
}

export async function getCustomerContext(db, customerId) {
  const result = await db.query(
    `SELECT c.id AS customer_id, c.name, c.status AS legacy_status,
            COALESCE(c.lifecycle_status,
              CASE c.status
                WHEN 'active' THEN 'ACTIVE'
                WHEN 'late' THEN 'PAST_DUE'
                WHEN 'suspended' THEN 'BLOCKED'
                WHEN 'cancelled' THEN 'CHURNED'
                ELSE 'LEAD'
              END) AS lifecycle_status,
            c.operational_stage,
            s.id AS subscription_id, s.status AS subscription_status,
            s.starts_on::text AS started_at, s.expires_on::text AS expires_at,
            s.provider, s.provider_reference, s.renewal_policy,
            p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
            pay.id AS payment_id, pay.status AS payment_status,
            pay.amount_cents, pay.currency, pay.confirmed_at,
            r.id AS renewal_id, r.core_status AS renewal_status,
            issue.id AS support_case_id, issue.status AS support_status,
            issue.summary AS support_summary
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT * FROM subscriptions
          WHERE customer_id = c.id
          ORDER BY created_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN plans p ON p.id = s.plan_id
       LEFT JOIN LATERAL (
         SELECT * FROM payments
          WHERE customer_id = c.id
          ORDER BY created_at DESC LIMIT 1
       ) pay ON true
       LEFT JOIN LATERAL (
         SELECT r.* FROM renewal_jobs r
          JOIN charges ch ON ch.id = r.charge_id
          WHERE ch.subscription_id = s.id
          ORDER BY r.created_at DESC LIMIT 1
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT * FROM customer_issues
          WHERE customer_id = c.id
          ORDER BY last_mentioned_at DESC LIMIT 1
       ) issue ON true
      WHERE c.id = $1`,
    [customerId]
  );
  if (!result.rows[0]) throw coreError('CUSTOMER_NOT_FOUND', 'Cliente não encontrado.');
  return result.rows[0];
}

export async function changeCustomerLifecycle(db, {
  customerId,
  next,
  event,
  actor,
  correlationId,
  causationId = null
}) {
  return db.transaction(async (client) => {
    const locked = await client.query(
      'SELECT status, lifecycle_status FROM customers WHERE id = $1 FOR UPDATE',
      [customerId]
    );
    if (!locked.rows[0]) throw coreError('CUSTOMER_NOT_FOUND', 'Cliente não encontrado.');
    const current = locked.rows[0].lifecycle_status || lifecycleFromLegacyStatus(locked.rows[0].status);
    const decision = transitionCustomerLifecycle({ current, next, event });
    if (!decision.allowed) {
      throw coreError('INVALID_TRANSITION', 'Transição de lifecycle não permitida.', decision);
    }
    if (!decision.changed) return { current, next, changed: false };
    await client.query(
      'UPDATE customers SET lifecycle_status = $2, updated_at = now() WHERE id = $1',
      [customerId, next]
    );
    await appendOutboxEvent(client, createBusinessEvent({
      eventType: 'customer.status_changed',
      correlationId,
      causationId,
      actor,
      subject: { type: 'customer', id: customerId },
      payload: { previous_status: current, current_status: next, transition_event: event }
    }));
    return { current, next, changed: true };
  });
}

export async function openSupportCase(db, {
  customerId,
  category,
  summary,
  message = null,
  requestId,
  correlationId,
  actor
}) {
  return db.transaction(async (client) => {
    const customer = await client.query('SELECT id FROM customers WHERE id = $1', [customerId]);
    if (!customer.rows[0]) throw coreError('CUSTOMER_NOT_FOUND', 'Cliente não encontrado.');
    const inserted = await client.query(
      `INSERT INTO customer_issues
        (customer_id, category, summary, last_message, correlation_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO UPDATE
         SET last_mentioned_at = customer_issues.last_mentioned_at
       RETURNING id, status, created_at, (xmax = 0) AS inserted`,
      [customerId, category, summary, message, correlationId, requestId]
    );
    const supportCase = inserted.rows[0];
    if (!supportCase.inserted) {
      return {
        id: supportCase.id,
        status: String(supportCase.status).toUpperCase(),
        created_at: supportCase.created_at,
        duplicate: true
      };
    }
    const event = createBusinessEvent({
      eventType: 'support.case_opened',
      correlationId,
      actor,
      subject: { type: 'support_case', id: supportCase.id },
      payload: { customer_id: customerId, category }
    });
    await appendOutboxEvent(client, event);
    return {
      id: supportCase.id,
      status: String(supportCase.status).toUpperCase(),
      created_at: supportCase.created_at,
      duplicate: false
    };
  });
}

export async function renewalReadiness(db, { customerId, subscriptionId = null }) {
  const result = await db.query(
    `SELECT s.id AS subscription_id, p.id AS payment_id, p.status AS payment_status,
            r.id AS renewal_id, r.core_status AS renewal_status
       FROM subscriptions s
       LEFT JOIN LATERAL (
         SELECT * FROM payments
          WHERE subscription_id = s.id
          ORDER BY created_at DESC LIMIT 1
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT r.* FROM renewal_jobs r
          JOIN charges ch ON ch.id = r.charge_id
          WHERE ch.subscription_id = s.id
          ORDER BY r.created_at DESC LIMIT 1
       ) r ON true
      WHERE s.customer_id = $1
        AND ($2::uuid IS NULL OR s.id = $2::uuid)
      ORDER BY s.created_at DESC LIMIT 1`,
    [customerId, subscriptionId]
  );
  if (!result.rows[0]) throw coreError('CUSTOMER_NOT_FOUND', 'Assinatura não encontrada.');
  const state = result.rows[0];
  if (state.renewal_status === 'COMPLETED') {
    throw coreError('RENEWAL_ALREADY_COMPLETED', 'A renovação já foi concluída.');
  }
  if (state.payment_status !== 'CONFIRMED') {
    throw coreError('PAYMENT_NOT_CONFIRMED', 'A renovação aguarda pagamento confirmado.');
  }
  return { ...state, status: state.renewal_status || 'READY' };
}

export async function renewalOperationStatus(db, { customerId, subscriptionId = null }) {
  const result = await db.query(
    `SELECT s.id AS subscription_id, p.id AS payment_id, p.status AS payment_status,
            r.id AS renewal_id, COALESCE(rs.state, r.core_status) AS renewal_status,
            rs.target_expiration::text, rs.last_error, rs.failure_class
       FROM subscriptions s
       LEFT JOIN LATERAL (
         SELECT * FROM payments
          WHERE customer_id = $1 AND subscription_id = s.id
          ORDER BY created_at DESC LIMIT 1
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT r.* FROM renewal_jobs r
          JOIN charges ch ON ch.id = r.charge_id
          WHERE ch.subscription_id = s.id
          ORDER BY r.created_at DESC LIMIT 1
       ) r ON true
       LEFT JOIN renewal_sagas rs ON rs.renewal_id = r.id
      WHERE s.customer_id = $1
        AND ($2::uuid IS NULL OR s.id = $2::uuid)
      ORDER BY s.created_at DESC LIMIT 1`,
    [customerId, subscriptionId]
  );
  if (!result.rows[0]) throw coreError('SUBSCRIPTION_NOT_FOUND', 'Assinatura não encontrada.');
  const current = result.rows[0];
  if (current.renewal_status === 'COMPLETED') {
    return { ...current, decision: 'ALREADY_RENEWED' };
  }
  if (['REQUESTED', 'READY', 'PROCESSING', 'VERIFYING', 'RETRY_SCHEDULED'].includes(current.renewal_status)) {
    return { ...current, decision: 'RENEWAL_ALREADY_IN_PROGRESS' };
  }
  if (current.renewal_status === 'HUMAN_ACTION_REQUIRED') {
    return { ...current, decision: 'REQUIRES_ACTION' };
  }
  if (current.renewal_status === 'FAILED') return { ...current, decision: 'FAILED' };
  if (current.payment_status === 'CONFIRMED') return { ...current, decision: 'READY' };
  if (['CREATED', 'PENDING'].includes(current.payment_status)) {
    return { ...current, decision: 'PAYMENT_PENDING' };
  }
  return { ...current, decision: 'PAYMENT_REQUIRED' };
}
