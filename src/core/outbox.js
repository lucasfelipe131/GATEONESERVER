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
