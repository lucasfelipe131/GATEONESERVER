import { eventEnvelopeSchema } from './contracts.js';

export async function appendOutboxEvent(client, rawEvent) {
  const event = eventEnvelopeSchema.parse(rawEvent);
  const result = await client.query(
    `INSERT INTO gate_event_outbox
      (event_id, event_type, event_version, occurred_at, correlation_id,
       causation_id, actor, subject, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      event.event_id,
      event.event_type,
      event.event_version,
      event.occurred_at,
      event.correlation_id,
      event.causation_id,
      JSON.stringify(event.actor),
      JSON.stringify(event.subject),
      JSON.stringify(event.payload)
    ]
  );
  return { stored: result.rowCount === 1, event };
}

export async function claimEventForConsumer(client, { consumer, eventId }) {
  const result = await client.query(
    `INSERT INTO gate_event_consumptions (consumer, event_id)
     VALUES ($1, $2)
     ON CONFLICT (consumer, event_id) DO NOTHING
     RETURNING event_id`,
    [consumer, eventId]
  );
  return result.rowCount === 1;
}

export async function consumeEventIdempotently(db, { consumer, event }, handler) {
  return db.transaction(async (client) => {
    const claimed = await claimEventForConsumer(client, {
      consumer,
      eventId: eventEnvelopeSchema.parse(event).event_id
    });
    if (!claimed) return { processed: false, duplicate: true };
    const result = await handler(client, event);
    return { processed: true, duplicate: false, result };
  });
}

export async function claimOutboxBatch(client, {
  workerId,
  limit = 50,
  now = new Date()
}) {
  const result = await client.query(
    `WITH candidates AS (
       SELECT event_id
         FROM gate_event_outbox
        WHERE publish_status IN ('PENDING', 'FAILED')
          AND terminal_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          AND (claimed_at IS NULL OR claimed_at < $1 - interval '5 minutes')
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2
     )
     UPDATE gate_event_outbox e
        SET claimed_by = $3, claimed_at = $1,
            publish_attempts = publish_attempts + 1
       FROM candidates c
      WHERE e.event_id = c.event_id
      RETURNING e.*`,
    [now, limit, workerId]
  );
  return result.rows;
}

export async function markOutboxPublished(client, { eventId, workerId, now = new Date() }) {
  const result = await client.query(
    `UPDATE gate_event_outbox
        SET publish_status = 'PUBLISHED', published_at = $3,
            claimed_by = NULL, claimed_at = NULL, last_error = NULL,
            next_attempt_at = NULL
      WHERE event_id = $1 AND claimed_by = $2
      RETURNING event_id`,
    [eventId, workerId, now]
  );
  return result.rowCount === 1;
}

export async function markOutboxFailed(client, {
  eventId,
  workerId,
  error,
  attempt,
  maxAttempts = 8,
  now = new Date(),
  baseDelayMs = 30_000
}) {
  const terminal = attempt >= maxAttempts;
  const nextAttempt = terminal
    ? null
    : new Date(now.getTime() + baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const result = await client.query(
    `UPDATE gate_event_outbox
        SET publish_status = 'FAILED', last_error = $3,
            claimed_by = NULL, claimed_at = NULL,
            next_attempt_at = $4, terminal_at = $5
      WHERE event_id = $1 AND claimed_by = $2
      RETURNING event_id`,
    [eventId, workerId, String(error?.message || error).slice(0, 2000), nextAttempt, terminal ? now : null]
  );
  return { updated: result.rowCount === 1, terminal, next_attempt_at: nextAttempt };
}

export class OutboxDispatcher {
  constructor({ db, workerId, handlers = {}, consumerName = 'gate-core.v1', maxAttempts = 8, logger = null }) {
    if (!consumerName || !workerId) throw new Error('OUTBOX_IDENTITY_REQUIRED');
    this.consumerName = consumerName;
    this.db = db;
    this.workerId = workerId;
    this.handlers = handlers;
    this.maxAttempts = maxAttempts;
    this.logger = logger;
  }

  async dispatchBatch({ limit = 50, now = new Date() } = {}) {
    const events = await this.db.transaction((client) => claimOutboxBatch(client, {
      workerId: this.workerId,
      limit,
      now
    }));
    const stats = { claimed: events.length, published: 0, failed: 0, terminal: 0 };
    for (const event of events) {
      const handler = this.handlers[event.event_type];
      try {
        if (!handler) throw Object.assign(new Error(`Consumer ausente: ${event.event_type}`), {
          code: 'CONSUMER_NOT_CONFIGURED'
        });
        const consumed = await consumeEventIdempotently(this.db, {
          consumer: `${this.consumerName}:${event.event_type}`,
          event: {
            event_id: event.event_id,
            event_type: event.event_type,
            event_version: event.event_version,
            occurred_at: new Date(event.occurred_at).toISOString(),
            correlation_id: event.correlation_id,
            causation_id: event.causation_id,
            actor: event.actor,
            subject: event.subject,
            payload: event.payload
          }
        }, (client, envelope) => handler(envelope, client));
        if (consumed.duplicate) this.logger?.info?.({ event_id: event.event_id }, 'IDEMPOTENT_NOOP');
        const acknowledged = await this.db.transaction((client) => markOutboxPublished(client, {
          eventId: event.event_id,
          workerId: this.workerId,
          now
        }));
        if (acknowledged) stats.published += 1;
      } catch (error) {
        const failure = await this.db.transaction((client) => markOutboxFailed(client, {
          eventId: event.event_id,
          workerId: this.workerId,
          error,
          attempt: Number(event.publish_attempts),
          maxAttempts: this.maxAttempts,
          now
        }));
        stats.failed += 1;
        if (failure.terminal) stats.terminal += 1;
        this.logger?.warn?.({
          event_id: event.event_id,
          event_type: event.event_type,
          correlation_id: event.correlation_id,
          attempt: event.publish_attempts,
          terminal: failure.terminal
        }, 'Falha persistida no dispatch da outbox');
      }
    }
    return stats;
  }
}
