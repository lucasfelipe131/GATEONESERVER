import { randomUUID } from 'node:crypto';

export function notificationRequested({
  notificationId = randomUUID(),
  customerId,
  channel,
  intention,
  context = {},
  correlationId,
  causationId = null,
  priority = 'NORMAL'
}) {
  if (!customerId || !correlationId) throw new Error('NotificationRequested requer customer e correlation ID.');
  if (!['WHATSAPP', 'EMAIL', 'IN_APP'].includes(channel)) throw new Error('Canal de notificação inválido.');
  if (!['LOW', 'NORMAL', 'HIGH'].includes(priority)) throw new Error('Prioridade inválida.');
  return Object.freeze({
    contract: 'NotificationRequested.v1',
    notification_id: notificationId,
    customer_id: customerId,
    channel,
    intention,
    context,
    correlation_id: correlationId,
    causation_id: causationId,
    priority
  });
}
