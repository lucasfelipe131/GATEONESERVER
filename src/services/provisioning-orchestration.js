import { randomUUID } from 'node:crypto';
import { createBusinessEvent } from '../core/events.js';
import { provisioningIdempotencyKey } from '../core/idempotency.js';
import { appendOutboxEvent } from '../core/outbox.js';
import {
  normalizeProvisioningResult,
  provisioningDecision,
  verifyExpiration
} from '../core/provisioning-orchestrator.js';
import { classifyOperationalFailure } from '../core/renewal-orchestrator.js';

export class PgProvisioningRepository {
  constructor(db) { this.db = db; }

  async createOrGet(input) {
    return this.db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO provisioning_operations
          (customer_id, subscription_id, renewal_id, provider, operation, status,
           orchestration_state, idempotency_key, correlation_id, causation_id,
           expected_expiration)
         VALUES ($1, $2, $3, $4, 'RENEW', 'REQUESTED', 'REQUESTED', $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO UPDATE
           SET updated_at = provisioning_operations.updated_at
         RETURNING *, (xmax = 0) AS inserted`,
        [input.customer_id, input.subscription_id, input.renewal_id, input.provider,
          input.idempotency_key, input.correlation_id, input.causation_id,
          input.expected_expiration]
      );
      const operation = result.rows[0];
      if (operation.inserted) {
        await appendOutboxEvent(client, createBusinessEvent({
          eventType: 'provisioning.requested', correlationId: input.correlation_id,
          causationId: input.causation_id,
          actor: { type: 'WORKER', id: 'provisioning-orchestrator' },
          subject: { type: 'provisioning', id: operation.id },
          payload: {
            customer_id: input.customer_id,
            subscription_id: input.subscription_id,
            renewal_id: input.renewal_id,
            provider: input.provider
          }
        }));
      }
      return operation;
    });
  }

  async processing(id) {
    return this.db.transaction(async (client) => {
      const result = await client.query(
        `UPDATE provisioning_operations
            SET status = 'PROCESSING', orchestration_state = 'PROCESSING',
                attempts = attempts + 1, updated_at = now()
          WHERE id = $1 AND orchestration_state IN ('REQUESTED', 'RETRY_SCHEDULED')
          RETURNING *`, [id]
      );
      const operation = result.rows[0];
      if (!operation) throw new Error('PROVISIONING_CONCURRENT_TRANSITION');
      await appendOutboxEvent(client, createBusinessEvent({
        eventType: 'provisioning.processing', correlationId: operation.correlation_id,
        causationId: operation.causation_id,
        actor: { type: 'WORKER', id: 'provisioning-orchestrator' },
        subject: { type: 'provisioning', id },
        payload: { renewal_id: operation.renewal_id, attempt: operation.attempts }
      }));
      return operation;
    });
  }

  async outcome(id, { result, decision }) {
    const legacyStatus = decision.next === 'HUMAN_ACTION_REQUIRED'
      ? 'HUMAN_ACTION_REQUIRED'
      : decision.next === 'VERIFYING' ? 'PROCESSING' : 'FAILED';
    const updated = await this.db.query(
      `UPDATE provisioning_operations
          SET status = $2, orchestration_state = $3, result = $4::jsonb,
              failure_reason = $5, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, legacyStatus, decision.next, JSON.stringify(result), result.reason]
    );
    return updated.rows[0];
  }

  async verification(id, verification) {
    return this.db.transaction(async (client) => {
      const state = verification.verified ? 'COMPLETED' : 'HUMAN_ACTION_REQUIRED';
      const result = await client.query(
        `UPDATE provisioning_operations
            SET status = $2, orchestration_state = $2,
                provider_expiration = $3,
                verified_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE verified_at END,
                failure_reason = $4, updated_at = now()
          WHERE id = $1 AND orchestration_state = 'VERIFYING'
          RETURNING *`,
        [id, state, verification.provider_expiration || null, verification.code]
      );
      const operation = result.rows[0];
      if (!operation) throw new Error('PROVISIONING_NOT_VERIFYING');
      await appendOutboxEvent(client, createBusinessEvent({
        eventType: verification.verified
          ? 'provisioning.completed'
          : 'provisioning.human_action_required',
        correlationId: operation.correlation_id,
        causationId: operation.causation_id,
        actor: { type: 'WORKER', id: 'provisioning-orchestrator' },
        subject: { type: 'provisioning', id },
        payload: {
          customer_id: operation.customer_id,
          subscription_id: operation.subscription_id,
          renewal_id: operation.renewal_id,
          verification
        }
      }));
      return operation;
    });
  }
}

class EphemeralProvisioningRepository {
  constructor() { this.operations = new Map(); }
  async createOrGet(input) {
    const key = input.idempotency_key;
    if (this.operations.has(key)) return this.operations.get(key);
    const operation = { id: randomUUID(), ...input, orchestration_state: 'REQUESTED', attempts: 0 };
    this.operations.set(key, operation);
    return operation;
  }
  async processing(id) {
    const operation = [...this.operations.values()].find((item) => item.id === id);
    operation.orchestration_state = 'PROCESSING'; operation.attempts += 1; return operation;
  }
  async outcome(id, { result, decision }) {
    const operation = [...this.operations.values()].find((item) => item.id === id);
    operation.orchestration_state = decision.next; operation.result = result; return operation;
  }
  async verification(id, verification) {
    const operation = [...this.operations.values()].find((item) => item.id === id);
    operation.orchestration_state = verification.verified ? 'COMPLETED' : 'HUMAN_ACTION_REQUIRED';
    operation.verification = verification; return operation;
  }
}

export class ProvisioningOrchestrator {
  constructor({ provider, repository = new EphemeralProvisioningRepository() }) {
    this.provider = provider;
    this.repository = repository;
  }

  async requestRenewal(input) {
    const operation = await this.operationFor(input);
    if (['VERIFYING', 'COMPLETED'].includes(operation.orchestration_state)) {
      return { operation, result: operation.result || { status: 'SUCCESS' },
        decision: { next: operation.orchestration_state, retry: false } };
    }
    const processing = await this.repository.processing(operation.id);
    let rawResult;
    try {
      rawResult = await this.provider.renewAccount({
        ...input,
        provisioning_id: operation.id,
        idempotency_key: operation.idempotency_key
      });
    } catch (error) {
      const failure = classifyOperationalFailure(error);
      rawResult = {
        status: failure.class === 'TRANSIENT'
          ? 'TEMPORARY_FAILURE'
          : failure.class === 'AUTHENTICATION'
            ? 'AUTH_REQUIRED'
            : failure.class === 'HUMAN_REQUIRED'
              ? 'HUMAN_ACTION_REQUIRED'
              : failure.class === 'PERMANENT'
                ? 'PERMANENT_FAILURE'
                : 'UNKNOWN',
        reason: error.message
      };
    }
    const result = normalizeProvisioningResult(rawResult);
    const decision = provisioningDecision(result);
    const persisted = await this.repository.outcome(operation.id, { result, decision });
    return { operation: persisted || processing, result, decision };
  }

  operationFor(input) {
    return this.repository.createOrGet({
      ...input,
      provider: this.provider.providerName,
      idempotency_key: provisioningIdempotencyKey(
        this.provider.providerName, 'RENEW', input.renewal_id
      )
    });
  }

  async verifyRenewal({ operation, previous_expiration, expected_expiration, ...input }) {
    const observed = normalizeProvisioningResult(await this.provider.getExpiration({
      ...input, provisioning_id: operation.id
    }));
    const verification = verifyExpiration({
      previousExpiration: previous_expiration,
      expectedExpiration: expected_expiration,
      providerExpiration: observed.expiration
    });
    await this.repository.verification(operation.id, verification);
    return verification;
  }
}
