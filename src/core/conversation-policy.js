export const POLICY_RESULTS = Object.freeze([
  'ALLOW',
  'DENY',
  'REQUIRE_CONFIRMATION',
  'REQUIRE_HUMAN'
]);

export const TOOL_RISK_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

const INTENT_TOOL_ALLOWLIST = Object.freeze({
  GREETING: ['resolveCustomer', 'getCustomerContext'],
  RENEWAL_REQUEST: ['resolveCustomer', 'getCustomerContext', 'getSubscription', 'getRenewalStatus', 'requestRenewal', 'createPaymentRequest'],
  PAYMENT_REQUEST: ['resolveCustomer', 'getCustomerContext', 'getSubscription', 'getPaymentStatus', 'getRenewalStatus', 'requestRenewal', 'createPaymentRequest'],
  PAYMENT_STATUS: ['resolveCustomer', 'getCustomerContext', 'getPaymentStatus', 'getRenewalStatus'],
  PAYMENT_EVIDENCE: ['resolveCustomer', 'getCustomerContext', 'getPaymentStatus', 'getRenewalStatus'],
  EXPIRATION_QUERY: ['resolveCustomer', 'getCustomerContext', 'getExpiration'],
  RENEWAL_STATUS: ['resolveCustomer', 'getCustomerContext', 'getRenewalStatus', 'getPaymentStatus'],
  SUBSCRIPTION_QUERY: ['resolveCustomer', 'getCustomerContext', 'getSubscription', 'getExpiration'],
  SUPPORT_REQUEST: ['resolveCustomer', 'getCustomerContext', 'getSubscription', 'getExpiration', 'getRenewalStatus', 'getOpenSupportCases', 'openSupportCase', 'requestHumanHandoff'],
  PLAN_QUERY: ['resolveCustomer', 'getCustomerContext', 'listPlans'],
  NEW_CUSTOMER: ['resolveCustomer', 'listPlans', 'requestHumanHandoff'],
  TRIAL_REQUEST: ['resolveCustomer', 'listPlans', 'requestHumanHandoff'],
  CANCELLATION_REQUEST: ['resolveCustomer', 'getCustomerContext', 'requestHumanHandoff'],
  REFERRAL: ['resolveCustomer', 'getCustomerContext', 'requestHumanHandoff'],
  HUMAN_REQUEST: ['resolveCustomer', 'getCustomerContext', 'requestHumanHandoff'],
  COMPLAINT: ['resolveCustomer', 'getCustomerContext', 'getOpenSupportCases', 'requestHumanHandoff'],
  UNKNOWN: ['resolveCustomer', 'getCustomerContext', 'requestHumanHandoff']
});

export class ConversationPolicyEngine {
  evaluate({ tool, intentResult, hasCustomer = false }) {
    if (!tool) return { result: 'DENY', code: 'TOOL_NOT_ALLOWLISTED' };
    if (intentResult?.security_flags?.includes('PROMPT_INJECTION')) {
      return { result: 'DENY', code: 'UNTRUSTED_INSTRUCTION' };
    }
    const intents = intentResult?.intents?.map((item) => item.name) || ['UNKNOWN'];
    if (tool.name === 'requestHumanHandoff') {
      return { result: 'ALLOW', code: 'HANDOFF_ALLOWED' };
    }
    const permitted = intents.some((intent) => INTENT_TOOL_ALLOWLIST[intent]?.includes(tool.name));
    if (!permitted) return { result: 'DENY', code: 'INTENT_TOOL_MISMATCH' };
    if (tool.requiresCustomer && !hasCustomer) {
      return { result: 'REQUIRE_HUMAN', code: 'CUSTOMER_REQUIRED' };
    }
    if (tool.risk === 'HIGH') return { result: 'REQUIRE_HUMAN', code: 'HIGH_RISK' };
    if (tool.risk === 'MEDIUM') {
      if (intentResult?.confidence === 'HIGH') return { result: 'ALLOW', code: 'POLICY_ALLOWED' };
      if (intentResult?.confidence === 'MEDIUM') {
        return { result: 'REQUIRE_CONFIRMATION', code: 'CONFIRMATION_REQUIRED' };
      }
      return { result: 'REQUIRE_HUMAN', code: 'LOW_CONFIDENCE_OPERATION' };
    }
    return { result: 'ALLOW', code: 'POLICY_ALLOWED' };
  }
}

export function permittedToolsForIntent(intent) {
  return [...(INTENT_TOOL_ALLOWLIST[intent] || [])];
}
