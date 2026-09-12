export const CORE_ACTION_CAPABILITIES = Object.freeze({
  'customer.resolve': 'customer.identity.resolve',
  'customer.context.get': 'customer.context.read',
  'conversation.process': 'conversation.agent.execute',
  'subscription.get': 'subscription.read',
  'plan.list': 'plan.read',
  'payment.request': 'payment.request',
  'payment.status.get': 'payment.read',
  'renewal.request': 'renewal.request',
  'renewal.status.get': 'renewal.read',
  'support.case.open': 'support.case.open',
  'support.case.list': 'support.case.read',
  'conversation.handoff.request': 'conversation.handoff'
});

const SERVICE_ACTIONS = Object.freeze({
  whatsapp: new Set(Object.keys(CORE_ACTION_CAPABILITIES))
});

export function authorizeCoreOperation(actor, action) {
  const capability = CORE_ACTION_CAPABILITIES[action];
  if (!capability) return { allowed: false, code: 'UNSUPPORTED_ACTION' };
  if (actor?.capability !== capability) {
    return { allowed: false, code: 'INSUFFICIENT_CAPABILITY', required_capability: capability };
  }
  if (actor?.type === 'SERVICE' && SERVICE_ACTIONS[actor.id]?.has(action)) {
    return { allowed: true, capability };
  }
  return { allowed: false, code: 'INSUFFICIENT_CAPABILITY', required_capability: capability };
}
