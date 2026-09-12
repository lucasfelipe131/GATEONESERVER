import { randomUUID } from 'node:crypto';
import { CORE_CONTRACT_VERSION, eventEnvelopeSchema } from './contracts.js';

export function createBusinessEvent({
  eventId = randomUUID(),
  eventType,
  occurredAt = new Date().toISOString(),
  correlationId = randomUUID(),
  causationId = null,
  actor,
  subject,
  payload = {}
}) {
  return eventEnvelopeSchema.parse({
    event_id: eventId,
    event_type: eventType,
    event_version: CORE_CONTRACT_VERSION,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    causation_id: causationId,
    actor,
    subject,
    payload
  });
}
