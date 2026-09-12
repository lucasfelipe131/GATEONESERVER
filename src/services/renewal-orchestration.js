import { randomUUID } from 'node:crypto';
import { createBusinessEvent } from '../core/events.js';
import { appendOutboxEvent } from '../core/outbox.js';
import { notificationRequested } from '../core/notifications.js';
import {
  assertRenewalInvariants,
  classifyOperationalFailure,
  expirationForPlan,
  retryAt,
  transitionRenewal
} from '../core/renewal-orchestrator.js';
import { ProvisioningOrchestrator } from './provisioning-orchestration.js';

function renewalEventType(state) {
  return ({
    REQUESTED: 'renewal.requested',
    READY: 'renewal.ready',
    PROCESSING: 'renewal.processing',
    VERIFYING: 'renewal.verifying',
    COMPLETED: 'renewal.completed',
    FAILED: 'renewal.failed',
    RETRY_SCHEDULED: 'renewal.retry_scheduled',
    HUMAN_ACTION_REQUIRED: 'renewal.human_action_required'
  })[state] || null;
}

export class PgRenewalRepository {
  constructor(db) { this.db = db; }

  async createOrGet(input) {
    return this.db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO renewal_sagas
          (renewal_id, customer_id, subscription_id, payment_id, correlation_id,
           causation_id, previous_expiration, target_expiration,
           requested_extension_months, expected_amount_cents,
           provisioning_provider, state, requested_by)
         SELECT $1, p.customer_id, p.subscription_id, p.id, $5, $6, $7, $8,
                $9, $10, $11, $12, $13::jsonb
           FROM payments p
           JOIN subscriptions s ON s.id = p.subscription_id
          WHERE p.id = $4
            AND p.customer_id = $2
            AND p.subscription_id = $3
            AND s.customer_id = $2
            AND p.status = 'CONFIRMED'
            AND p.amount_cents = $10
         ON CONFLICT (payment_id) DO UPDATE SET updated_at = renewal_sagas.updated_at
         RETURNING *, (xmax = 0) AS inserted`,
        [input.renewal_id, input.customer_id, input.subscription_id, input.payment_id,
          input.correlation_id, input.causation_id, input.previous_expiration,
          input.target_expiration, input.requested_extension_months,
          input.expected_amount_cents, input.provisioning_provider, input.state,
          JSON.stringify(input.requested_by)]
      );
      if (!result.rows[0]) throw new Error('RENEWAL_PAYMENT_INVARIANT_FAILED');
      return result.rows[0];
    });
  }

  async get(renewalId) {
    const result = await this.db.query(
      `SELECT rs.*, p.status AS payment_status, p.amount_cents, p.customer_id AS payment_customer_id,
              p.subscription_id AS payment_subscription_id,
              s.customer_id AS subscription_customer_id
         FROM renewal_sagas rs
         JOIN payments p ON p.id = rs.payment_id
         JOIN subscriptions s ON s.id = rs.subscription_id
        WHERE rs.renewal_id = $1`, [renewalId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row,
      payment: {
        id: row.payment_id,
        status: row.payment_status,
        amount_cents: row.amount_cents,
        customer_id: row.payment_customer_id,
        subscription_id: row.payment_subscription_id
      },
      subscription: { id: row.subscription_id, customer_id: row.subscription_customer_id }
    };
  }

  async transition(renewalId, { from, to, reason = null, failure = null, nextRetryAt = null }) {
    transitionRenewal(from, to);
    return this.db.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE renewal_sagas
            SET state = $3, revision = revision + 1,
                attempts = attempts + CASE WHEN $3 = 'PROCESSING' THEN 1 ELSE 0 END,
                processing_at = CASE WHEN $3 = 'PROCESSING' THEN COALESCE(processing_at, now()) ELSE processing_at END,
                verified_at = CASE WHEN $3 = 'COMPLETED' THEN COALESCE(verified_at, now()) ELSE verified_at END,
                completed_at = CASE WHEN $3 = 'COMPLETED' THEN COALESCE(completed_at, now()) ELSE completed_at END,
                last_error = $4, failure_class = $5, next_retry_at = $6, updated_at = now()
          WHERE renewal_id = $1 AND state = $2
          RETURNING *`,
        [renewalId, from, to, reason, failure?.class || null, nextRetryAt]
      );
      if (!updated.rowCount) throw Object.assign(new Error('RENEWAL_CONCURRENT_TRANSITION'), {
        code: 'RENEWAL_CONCURRENT_TRANSITION'
      });
      const saga = updated.rows[0];
      await client.query(
        `INSERT INTO operational_transition_audit
          (actor, operation, entity_type, entity_id, before_state, after_state, reason, correlation_id)
         VALUES ($1::jsonb, 'renewal.transition', 'renewal', $2, $3::jsonb, $4::jsonb, $5, $6)`,
        [JSON.stringify({ type: 'WORKER', id: 'renewal-orchestrator' }), renewalId,
          JSON.stringify({ state: from }), JSON.stringify({ state: to }), reason, saga.correlation_id]
      );
      const eventType = renewalEventType(to);
      if (eventType) {
        const event = createBusinessEvent({
          eventType, correlationId: saga.correlation_id,
          causationId: saga.last_event_id || saga.causation_id,
          actor: { type: 'WORKER', id: 'renewal-orchestrator' },
          subject: { type: 'renewal', id: renewalId },
          payload: {
            customer_id: saga.customer_id,
            subscription_id: saga.subscription_id,
            payment_id: saga.payment_id,
            state: to,
            attempt: saga.attempts,
            ...(reason ? { reason } : {})
          }
        });
        await appendOutboxEvent(client, event);
        await client.query(
          `UPDATE renewal_sagas SET last_event_id = $2 WHERE renewal_id = $1`,
          [renewalId, event.event_id]
        );
      }
      return saga;
    });
  }

  async complete(renewalId, { expectedExpiration, providerExpiration }) {
    return this.db.transaction(async (client) => {
      const sagaResult = await client.query(
        `SELECT * FROM renewal_sagas WHERE renewal_id = $1 AND state = 'VERIFYING' FOR UPDATE`,
        [renewalId]
      );
      const saga = sagaResult.rows[0];
      if (!saga) throw new Error('RENEWAL_NOT_VERIFYING');
      const subscription = await client.query(
        `UPDATE subscriptions SET expires_on = $2, status = 'active', updated_at = now()
          WHERE id = $1 AND customer_id = $3
          RETURNING expires_on::text`,
        [saga.subscription_id, expectedExpiration, saga.customer_id]
      );
      if (!subscription.rowCount || subscription.rows[0].expires_on !== providerExpiration) {
        throw new Error('SUBSCRIPTION_UPDATE_MISMATCH');
      }
      await client.query(
        `UPDATE renewal_sagas
            SET state = 'COMPLETED', revision = revision + 1, verified_at = now(),
                completed_at = now(), last_error = NULL, failure_class = NULL,
                next_retry_at = NULL, updated_at = now()
          WHERE renewal_id = $1`, [renewalId]
      );
      await client.query(
        `UPDATE renewal_jobs
            SET core_status = 'COMPLETED', completed_at = now(), after_expiry = $2,
                failure_reason = NULL, updated_at = now()
          WHERE id = $1 AND core_status <> 'COMPLETED'`, [renewalId, providerExpiration]
      );
      const completedEvent = createBusinessEvent({
        eventType: 'renewal.completed', correlationId: saga.correlation_id,
        causationId: saga.last_event_id || saga.causation_id,
        actor: { type: 'WORKER', id: 'renewal-orchestrator' },
        subject: { type: 'renewal', id: renewalId },
        payload: {
          customer_id: saga.customer_id,
          subscription_id: saga.subscription_id,
          payment_id: saga.payment_id,
          previous_expiration: saga.previous_expiration,
          current_expiration: providerExpiration
        }
      });
      await appendOutboxEvent(client, completedEvent);
      const notification = notificationRequested({
        customerId: saga.customer_id, channel: 'WHATSAPP',
        intention: 'RENEWAL_COMPLETED',
        context: { renewal_id: renewalId, expiration: providerExpiration },
        correlationId: saga.correlation_id, causationId: completedEvent.event_id,
        priority: 'NORMAL'
      });
      await client.query(
        `INSERT INTO notification_requests
          (id, customer_id, channel, intention, context, priority, correlation_id, causation_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [notification.notification_id, notification.customer_id, notification.channel,
          notification.intention, JSON.stringify(notification.context), notification.priority,
          notification.correlation_id, notification.causation_id]
      );
      await appendOutboxEvent(client, createBusinessEvent({
        eventType: 'notification.requested', correlationId: saga.correlation_id,
        causationId: completedEvent.event_id,
        actor: { type: 'SYSTEM', id: 'gate-core' },
        subject: { type: 'notification', id: notification.notification_id },
        payload: notification
      }));
      return { ...saga, state: 'COMPLETED', provider_expiration: providerExpiration };
    });
  }
}

export class RenewalOrchestrator {
  constructor({ repository, provider = null, provisioning = null, maxAttempts = 5, now = () => new Date(), logger = null }) {
    this.repository = repository;
    this.provisioning = provisioning || new ProvisioningOrchestrator({ provider });
    this.provider = this.provisioning.provider;
    this.maxAttempts = maxAttempts;
    this.now = now;
    this.logger = logger;
  }

  async start({
    renewalId = randomUUID(), customerId, subscriptionId, payment,
    previousExpiration, requestedExtensionMonths, requestedBy,
    correlationId = randomUUID(), causationId = null, expectedAmountCents = null
  }) {
    const targetExpiration = expirationForPlan(previousExpiration, {
      durationMonths: requestedExtensionMonths
    });
    const renewal = {
      renewal_id: renewalId, customer_id: customerId, subscription_id: subscriptionId,
      payment_id: payment.id, correlation_id: correlationId, causation_id: causationId,
      previous_expiration: previousExpiration, target_expiration: targetExpiration,
      requested_extension_months: requestedExtensionMonths,
      expected_amount_cents: expectedAmountCents || payment.amount_cents,
      provisioning_provider: this.provider.providerName, state: 'READY', requested_by: requestedBy
    };
    assertRenewalInvariants({
      renewal: { ...renewal, state: 'READY' }, payment,
      subscription: { id: subscriptionId, customer_id: customerId },
      expectedAmountCents
    });
    return this.repository.createOrGet(renewal);
  }

  async run(renewalId) {
    let saga = await this.repository.get(renewalId);
    if (!saga) throw new Error('RENEWAL_NOT_FOUND');
    if (saga.state === 'COMPLETED') return { duplicate: true, saga };
    assertRenewalInvariants({ renewal: saga, payment: saga.payment, subscription: saga.subscription });
    try {
      const provisioningInput = {
        renewal_id: renewalId,
        customer_id: saga.customer_id,
        subscription_id: saga.subscription_id,
        expected_expiration: saga.target_expiration,
        requested_extension_months: saga.requested_extension_months,
        correlation_id: saga.correlation_id,
        causation_id: saga.causation_id
      };
      let provisioningOperation = null;
      if (['READY', 'RETRY_SCHEDULED'].includes(saga.state)) {
        saga = await this.repository.transition(renewalId, {
          from: saga.state, to: 'PROCESSING'
        });
        const provisioning = await this.provisioning.requestRenewal(provisioningInput);
        provisioningOperation = provisioning.operation;
        const { result, decision } = provisioning;
        if (decision.next !== 'VERIFYING') {
          return this.#handleProviderDecision(saga, decision, result.reason || result.status);
        }
        saga = await this.repository.transition(renewalId, {
          from: 'PROCESSING', to: 'VERIFYING'
        });
      } else if (!['PROCESSING', 'VERIFYING'].includes(saga.state)) {
        return { duplicate: false, saga, paused: true };
      }
      if (saga.state === 'PROCESSING') {
        saga = await this.repository.transition(renewalId, {
          from: 'PROCESSING', to: 'VERIFYING', reason: 'RECOVERY_VERIFICATION'
        });
      }
      provisioningOperation ||= await this.provisioning.operationFor(provisioningInput);
      const verification = await this.provisioning.verifyRenewal({
        operation: provisioningOperation,
        previous_expiration: saga.previous_expiration,
        expected_expiration: saga.target_expiration,
        ...provisioningInput
      });
      const providerExpiration = verification.provider_expiration;
      if (!verification.verified) {
        const failure = { class: 'BUSINESS_RULE', retryable: false, human_required: true };
        const paused = await this.repository.transition(renewalId, {
          from: 'VERIFYING', to: 'HUMAN_ACTION_REQUIRED',
          reason: verification.code, failure
        });
        return { duplicate: false, saga: paused, verification };
      }
      const completed = await this.repository.complete(renewalId, {
        expectedExpiration: saga.target_expiration,
        providerExpiration
      });
      return { duplicate: false, saga: completed, verification };
    } catch (error) {
      const latest = await this.repository.get(renewalId);
      if (!latest || ['COMPLETED', 'FAILED', 'HUMAN_ACTION_REQUIRED'].includes(latest.state)) throw error;
      const failure = classifyOperationalFailure(error);
      const nextRetryAt = failure.retryable
        ? retryAt({ attempt: Number(latest.attempts || 1), now: this.now(), maxAttempts: this.maxAttempts })
        : null;
      const to = failure.human_required
        ? 'HUMAN_ACTION_REQUIRED'
        : nextRetryAt ? 'RETRY_SCHEDULED' : 'FAILED';
      const failed = await this.repository.transition(renewalId, {
        from: latest.state, to, reason: error.message, failure, nextRetryAt
      });
      this.logger?.warn?.({
        renewal_id: renewalId,
        customer_id: latest.customer_id,
        subscription_id: latest.subscription_id,
        correlation_id: latest.correlation_id,
        state: to,
        attempt: latest.attempts,
        result: failure.class
      }, 'Renewal saga pausada após falha operacional');
      return { duplicate: false, saga: failed, failure };
    }
  }

  #handleProviderDecision(saga, decision, reason) {
    const failure = decision.next === 'RETRY_SCHEDULED'
      ? { class: 'TRANSIENT', retryable: true, human_required: false }
      : decision.next === 'HUMAN_ACTION_REQUIRED'
        ? { class: 'HUMAN_REQUIRED', retryable: false, human_required: true }
        : { class: 'PERMANENT', retryable: false, human_required: false };
    const nextRetryAt = decision.retry
      ? retryAt({ attempt: Number(saga.attempts || 1), now: this.now(), maxAttempts: this.maxAttempts })
      : null;
    return this.repository.transition(saga.renewal_id, {
      from: 'PROCESSING', to: nextRetryAt ? decision.next : decision.next === 'RETRY_SCHEDULED' ? 'FAILED' : decision.next,
      reason, failure, nextRetryAt
    }).then((updated) => ({ duplicate: false, saga: updated, failure }));
  }
}
