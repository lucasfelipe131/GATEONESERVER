import { CORE_EVENT_TYPES } from '../core/contracts.js';

// Audit/read models are written with the case transaction. These are observational
// deliveries in the existing outbox, not a second event bus or external effects.
export function createSupportEventHandlers() {
  return Object.fromEntries(
    CORE_EVENT_TYPES.filter(
      (type) => type.startsWith('support.') || type.startsWith('exception.'),
    ).map((type) => [
      type,
      async (event) => ({
        observed: true,
        event_id: event.event_id,
        customer_id: event.payload.customer_id || null,
      }),
    ]),
  );
}
