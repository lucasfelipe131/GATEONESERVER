import { ConversationPolicyEngine } from '../core/conversation-policy.js';

function required(...fields) {
  return (input) => fields.every((field) => input && input[field] !== undefined && input[field] !== null);
}

const anyObject = (input) => Boolean(input && typeof input === 'object' && !Array.isArray(input));

export const CONVERSATION_TOOL_DEFINITIONS = Object.freeze({
  resolveCustomer: Object.freeze({
    name: 'resolveCustomer', domain: 'CUSTOMER', capability: 'customer.identity.resolve', risk: 'LOW',
    purpose: 'Resolver uma identidade externa sem expor candidatos indevidos.',
    inputSchema: { required: ['type', 'value', 'provider'] }, outputSchema: { statuses: ['MATCHED', 'AMBIGUOUS', 'NOT_FOUND'] },
    validateInput: required('type', 'value', 'provider'), requiresCustomer: false,
    idempotency: 'READ_ONLY', timeoutMs: 4_000, retryPolicy: { maxAttempts: 2, safe: true }, audit: 'SUMMARY'
  }),
  getCustomerContext: Object.freeze({
    name: 'getCustomerContext', domain: 'CUSTOMER', capability: 'customer.context.read', risk: 'LOW',
    purpose: 'Carregar ContextSnapshot autorizado para uma finalidade explícita.',
    inputSchema: { required: ['customer_id', 'purpose', 'correlation_id'] }, outputSchema: { contract: 'ContextSnapshot.v1' },
    validateInput: required('customer_id', 'purpose', 'correlation_id'), requiresCustomer: true,
    idempotency: 'READ_ONLY', timeoutMs: 8_000, retryPolicy: { maxAttempts: 2, safe: true }, audit: 'SUMMARY'
  }),
  getSubscription: Object.freeze({
    name: 'getSubscription', domain: 'SUBSCRIPTION', capability: 'subscription.read', risk: 'LOW',
    purpose: 'Consultar a assinatura autoritativa do customer.',
    inputSchema: { required: ['customer_id'] }, outputSchema: { required: ['customer_id'] },
    validateInput: required('customer_id'), requiresCustomer: true,
    idempotency: 'READ_ONLY', timeoutMs: 4_000, retryPolicy: { maxAttempts: 2, safe: true }, audit: 'SUMMARY'
  }),
  getExpiration: Object.freeze({
    name: 'getExpiration', domain: 'SUBSCRIPTION', capability: 'subscription.read', risk: 'LOW',
    purpose: 'Consultar vencimento na fonte autoritativa da subscription.',
    inputSchema: { required: ['customer_id'] }, outputSchema: { fields: ['subscription_id', 'expires_at'] },
    validateInput: required('customer_id'), requiresCustomer: true,
    idempotency: 'READ_ONLY', timeoutMs: 4_000, retryPolicy: { maxAttempts: 2, safe: true }, audit: 'SUMMARY'
  }),
  listPlans: Object.freeze({
    name: 'listPlans', domain: 'CATALOG', capability: 'plan.read', risk: 'LOW',
    purpose: 'Consultar planos, preços e termos na configuração empresarial.',
    inputSchema: { type: 'object' }, outputSchema: { type: 'array' },
    validateInput: anyObject, requiresCustomer: false,
    idempotency: 'READ_ONLY', timeoutMs: 4_000, retryPolicy: { maxAttempts: 2, safe: true }, audit: 'SUMMARY'
  }),
  createPaymentRequest: Object.freeze({
    name: 'createPaymentRequest', domain: 'BILLING', capability: 'payment.request', risk: 'MEDIUM',
    purpose: 'Criar ou reutilizar cobrança de renovação válida pelo Billing.',
    inputSchema: { required: ['customer_id', 'idempotency_key'] }, outputSchema: { fields: ['charge_id', 'status', 'existing'] },
    validateInput: required('customer_id', 'idempotency_key'), requiresCustomer: true,
    idempotency: 'IDEMPOTENCY_KEY', timeoutMs: 10_000, retryPolicy: { maxAttempts: 1, safe: false }, audit: 'FULL_METADATA'
  }),
  getPaymentStatus: Object.freeze({
    name: 'getPaymentStatus', domain: 'BILLING', capability: 'payment.read', risk: 'LOW',
    purpose: 'Consultar estado financeiro normalizado do customer/subscription.',
    inputSchema: { required: ['customer_id'] }, outputSchema: { fields: ['payment_id', 'status'] },
    validateInput: required('customer_id'), requiresCustomer: true,
    idempotency: 'READ_ONLY', timeoutMs: 4_000, retryPolicy: { maxAttempts: 2, safe: true }, audit: 'SUMMARY'
  }),
  requestRenewal: Object.freeze({
    name: 'requestRenewal', domain: 'RENEWAL', capability: 'renewal.request', risk: 'MEDIUM',
    purpose: 'Solicitar decisão do Renewal Engine sem executar provisioning diretamente.',
    inputSchema: { required: ['customer_id', 'idempotency_key'] }, outputSchema: { fields: ['decision', 'renewal_status'] },
    validateInput: required('customer_id', 'idempotency_key'), requiresCustomer: true,
    idempotency: 'IDEMPOTENCY_KEY', timeoutMs: 6_000, retryPolicy: { maxAttempts: 1, safe: false }, audit: 'FULL_METADATA'
  }),
  getRenewalStatus: Object.freeze({
    name: 'getRenewalStatus', domain: 'RENEWAL', capability: 'renewal.read', risk: 'LOW',
    purpose: 'Consultar estado persistido da Renewal Saga.',
    inputSchema: { required: ['customer_id'] }, outputSchema: { fields: ['decision', 'renewal_status'] },
    validateInput: required('customer_id'), requiresCustomer: true,
    idempotency: 'READ_ONLY', timeoutMs: 4_000, retryPolicy: { maxAttempts: 2, safe: true }, audit: 'SUMMARY'
  }),
  getOpenSupportCases: Object.freeze({
    name: 'getOpenSupportCases', domain: 'SUPPORT', capability: 'support.case.read', risk: 'LOW',
    purpose: 'Consultar casos de suporte abertos do customer.',
    inputSchema: { required: ['customer_id'] }, outputSchema: { type: 'array' },
    validateInput: required('customer_id'), requiresCustomer: true,
    idempotency: 'READ_ONLY', timeoutMs: 4_000, retryPolicy: { maxAttempts: 2, safe: true }, audit: 'SUMMARY'
  }),
  openSupportCase: Object.freeze({
    name: 'openSupportCase', domain: 'SUPPORT', capability: 'support.case.open', risk: 'MEDIUM',
    purpose: 'Abrir ou reutilizar caso de suporte com contexto e idempotência.',
    inputSchema: { required: ['customer_id', 'summary', 'idempotency_key'] }, outputSchema: { fields: ['id', 'status'] },
    validateInput: required('customer_id', 'summary', 'idempotency_key'), requiresCustomer: true,
    idempotency: 'IDEMPOTENCY_KEY', timeoutMs: 6_000, retryPolicy: { maxAttempts: 1, safe: false }, audit: 'FULL_METADATA'
  }),
  requestHumanHandoff: Object.freeze({
    name: 'requestHumanHandoff', domain: 'CONVERSATION', capability: 'conversation.handoff', risk: 'MEDIUM',
    purpose: 'Registrar handoff com contexto antes de comunicar escalonamento.',
    inputSchema: { required: ['conversation_id', 'reason', 'idempotency_key'] }, outputSchema: { fields: ['handoff_id', 'status'] },
    validateInput: required('conversation_id', 'reason', 'idempotency_key'), requiresCustomer: false,
    idempotency: 'IDEMPOTENCY_KEY', timeoutMs: 6_000, retryPolicy: { maxAttempts: 1, safe: false }, audit: 'FULL_METADATA'
  })
});

function timeout(promise, timeoutMs, toolName) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Object.assign(
        new Error(`Tool ${toolName} excedeu o timeout.`),
        { code: 'TOOL_TIMEOUT' }
      )), timeoutMs);
      timer.unref?.();
    })
  ]);
}

function summarize(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  const allowed = new Set([
    'status', 'decision', 'customer_id', 'subscription_id', 'payment_id',
    'renewal_id', 'charge_id', 'existing', 'duplicate', 'handoff_id',
    'context_snapshot_id', 'error_code'
  ]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
}

function validOutput(tool, value) {
  const schema = tool.outputSchema || {};
  if (schema.type === 'array') return Array.isArray(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (schema.contract && value.contract !== schema.contract) return false;
  if (schema.statuses && !schema.statuses.includes(value.status)) return false;
  if (schema.required && !schema.required.every((field) => value[field] !== undefined)) return false;
  return true;
}

export class ConversationToolRegistry {
  constructor({ handlers = {}, policy = new ConversationPolicyEngine(), maxToolCalls = 8, maxSameToolRetries = 1 } = {}) {
    this.handlers = handlers;
    this.policy = policy;
    this.maxToolCalls = maxToolCalls;
    this.maxSameToolRetries = maxSameToolRetries;
  }

  definition(name) {
    return CONVERSATION_TOOL_DEFINITIONS[name] || null;
  }

  beginTurn({ intentResult, customerId = null }) {
    const calls = [];
    const counts = new Map();
    return {
      calls,
      execute: async (name, input = {}) => {
        const tool = this.definition(name);
        if (!tool) {
          const error = Object.assign(new Error(`Tool não registrada: ${name}`), { code: 'TOOL_NOT_ALLOWLISTED' });
          calls.push({ tool: name, status: 'DENIED', policy: 'DENY', error_code: error.code });
          throw error;
        }
        if (calls.length >= this.maxToolCalls) {
          throw Object.assign(new Error('Limite de tools por turno excedido.'), { code: 'TOOL_LOOP_LIMIT' });
        }
        if (!tool.validateInput(input)) {
          const error = Object.assign(new Error(`Input inválido para ${name}.`), { code: 'TOOL_INPUT_INVALID' });
          calls.push({ tool: name, status: 'FAILED', policy: 'DENY', error_code: error.code });
          throw error;
        }
        const decision = this.policy.evaluate({
          tool,
          intentResult,
          hasCustomer: Boolean(customerId || input.customer_id)
        });
        if (decision.result !== 'ALLOW') {
          calls.push({ tool: name, status: 'DENIED', policy: decision.result, error_code: decision.code });
          const error = Object.assign(new Error(`Policy bloqueou ${name}: ${decision.code}`), {
            code: decision.code,
            policy_result: decision.result
          });
          throw error;
        }
        const handler = this.handlers[name];
        if (typeof handler !== 'function') {
          throw Object.assign(new Error(`Handler indisponível para ${name}.`), { code: 'TOOL_HANDLER_UNAVAILABLE' });
        }
        const already = counts.get(name) || 0;
        if (already > this.maxSameToolRetries) {
          throw Object.assign(new Error(`Repetição excessiva da tool ${name}.`), { code: 'TOOL_REPEAT_LIMIT' });
        }
        counts.set(name, already + 1);
        const startedAt = new Date();
        const maxAttempts = Math.min(tool.retryPolicy.maxAttempts, this.maxSameToolRetries + 1);
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const data = await timeout(Promise.resolve(handler(input)), tool.timeoutMs, name);
            if (!validOutput(tool, data)) {
              throw Object.assign(new Error(`Output inválido para ${name}.`), {
                code: 'TOOL_OUTPUT_INVALID'
              });
            }
            calls.push({
              tool: name, capability: tool.capability, risk: tool.risk, policy: decision.result,
              status: 'SUCCESS', attempt, input: summarize(input), result: summarize(data),
              duration_ms: Date.now() - startedAt.getTime()
            });
            return data;
          } catch (error) {
            lastError = error;
            const retryable = tool.retryPolicy.safe && attempt < maxAttempts &&
              ['TOOL_TIMEOUT', 'TEMPORARY_FAILURE', 'PROVIDER_UNAVAILABLE'].includes(error.code);
            if (!retryable) break;
          }
        }
        calls.push({
          tool: name, capability: tool.capability, risk: tool.risk, policy: decision.result,
          status: 'FAILED', attempt: maxAttempts, input: summarize(input),
          error_code: lastError?.code || 'TOOL_FAILED', duration_ms: Date.now() - startedAt.getTime()
        });
        throw lastError || Object.assign(new Error(`Falha na tool ${name}.`), { code: 'TOOL_FAILED' });
      }
    };
  }
}
