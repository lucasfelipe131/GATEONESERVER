import { OutboxDispatcher } from '../core/outbox.js';
import { startOutboxRuntime } from '../core/outbox-runtime.js';
import { FakeProvisioningProvider } from '../core/provisioning-orchestrator.js';
import { PgRenewalRepository, RenewalOrchestrator } from './renewal-orchestration.js';
import { PgProvisioningRepository, ProvisioningOrchestrator } from './provisioning-orchestration.js';
import { createPhase4EventHandlers } from './phase4-event-handlers.js';

export function startStagingOutbox({ db, env = process.env, workerId, logger = console }) {
  if (env.OUTBOX_DISPATCHER_ENABLED !== 'true') return null;
  if (env.GATE_ENVIRONMENT !== 'staging-055' || env.GATE_TEST_MODE !== 'true' ||
      env.PROVIDER_MODE !== 'fake-only' || env.BITPANEL_MODE !== 'disabled' ||
      env.PAYMENT_MODE !== 'simulation' || env.WHATSAPP_MODE !== 'simulation') {
    throw new Error('OUTBOX_STAGING_GUARD_FAILED');
  }
  const handlers = {};
  for (const type of ['payment.confirmed', 'renewal.ready']) {
    handlers[type] = async (event, client) => {
      // All internal writes share the consumer-marker transaction. This adapter
      // is exclusively a fake simulation, not a distributed provider transaction.
      const tx = { query: client.query.bind(client), transaction: fn => fn(client) };
      const provider = new FakeProvisioningProvider({
        renewAccount: input => ({ status: 'SUCCESS', expiration: input.expected_expiration }),
        getExpiration: async input => {
          const row = await client.query('SELECT result FROM provisioning_operations WHERE id = $1', [input.provisioning_id]);
          return row.rows[0]?.result || { status: 'UNKNOWN' };
        }
      });
      const provisioning = new ProvisioningOrchestrator({ provider, repository: new PgProvisioningRepository(tx) });
      const renewalOrchestrator = new RenewalOrchestrator({ repository: new PgRenewalRepository(tx), provisioning });
      return createPhase4EventHandlers({ db: tx, renewalOrchestrator })[type](event);
    };
  }
  // Observational lifecycle events have no additional business effect.
  for (const type of ['payment.created', 'renewal.requested', 'renewal.processing', 'renewal.verifying',
    'renewal.completed', 'renewal.failed', 'renewal.human_action_required', 'provisioning.requested',
    'provisioning.processing', 'provisioning.verifying', 'provisioning.completed']) {
    handlers[type] = async () => ({ observed: true });
  }
  // Fake delivery only: no transport import, network request or customer message.
  handlers['notification.requested'] = async (event, client) => {
    const result = await client.query(`UPDATE notification_requests SET status = 'SENT', updated_at = now()
      WHERE id = $1 AND customer_id = $2 AND status = 'PENDING' RETURNING id`,
    [event.subject.id, event.payload.customer_id]);
    return { simulated: true, delivered: result.rowCount === 1 };
  };
  logger.info('OUTBOX_DISPATCHER_STARTED_FAKE_ONLY');
  return startOutboxRuntime({ dispatcher: new OutboxDispatcher({ db, workerId, handlers, logger, env }), logger });
}
