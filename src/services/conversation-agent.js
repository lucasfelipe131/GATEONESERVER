import { randomUUID } from 'node:crypto';
import { understandRequest } from '../core/conversation-intents.js';
import { GATE_CONVERSATION_AGENT_PROMPT_VERSION } from '../core/conversation-prompt.js';
import {
  avoidRepeatedResponse,
  mergeResponseFacts,
  renderConversationResponse,
  responseFactsFromContext,
  safeResponseForFacts,
  validateConversationResponse
} from '../core/conversation-responses.js';
import { RenewalAgent } from './renewal-agent.js';

const AUTOMATION_ELIGIBLE = new Set([
  'GREETING', 'RENEWAL_REQUEST', 'PAYMENT_REQUEST', 'PAYMENT_STATUS',
  'PAYMENT_EVIDENCE', 'EXPIRATION_QUERY', 'RENEWAL_STATUS',
  'SUBSCRIPTION_QUERY', 'SUPPORT_REQUEST', 'PLAN_QUERY'
]);

function contextPurpose(intent) {
  if (['RENEWAL_REQUEST', 'RENEWAL_STATUS'].includes(intent)) return 'RENEWAL';
  if (['PAYMENT_REQUEST', 'PAYMENT_STATUS', 'PAYMENT_EVIDENCE', 'EXPIRATION_QUERY'].includes(intent)) return 'PAYMENT';
  if (['SUPPORT_REQUEST', 'COMPLAINT', 'HUMAN_REQUEST', 'CANCELLATION_REQUEST'].includes(intent)) return 'SUPPORT';
  if (['PLAN_QUERY', 'NEW_CUSTOMER', 'TRIAL_REQUEST', 'REFERRAL'].includes(intent)) return 'SALES';
  return 'CONVERSATION';
}

function requestedScopes(intent) {
  const common = ['IDENTITY', 'LIFECYCLE', 'SUBSCRIPTION', 'CONVERSATION', 'PENDING_ACTIONS'];
  if (['RENEWAL_REQUEST', 'RENEWAL_STATUS', 'PAYMENT_REQUEST', 'PAYMENT_STATUS', 'PAYMENT_EVIDENCE'].includes(intent)) {
    return [...common, 'PAYMENT', 'RENEWAL'];
  }
  if (['SUPPORT_REQUEST', 'COMPLAINT', 'HUMAN_REQUEST', 'CANCELLATION_REQUEST'].includes(intent)) {
    return [...common, 'RENEWAL', 'SUPPORT', 'MEMORY'];
  }
  return common;
}

function statusFromToolError(error) {
  if (error?.policy_result === 'REQUIRE_CONFIRMATION') return 'CONFIRMATION_REQUIRED';
  if (error?.policy_result === 'REQUIRE_HUMAN') return 'HUMAN_REQUIRED';
  if (error?.policy_result === 'DENY') return 'POLICY_DENIED';
  return 'TOOL_FAILED';
}

function resultFromStored(stored) {
  return {
    contract: 'GateConversationTurn.v1',
    handled: true,
    duplicate: true,
    decision_id: stored.decision_id,
    customer_id: stored.customer_id || null,
    context_snapshot_id: stored.context_snapshot_id || null,
    correlation_id: stored.correlation_id,
    response_text: stored.response_text,
    response_facts: stored.response_facts || {},
    response_status: stored.response_status,
    outcome: stored.outcome
  };
}

export class GateConversationAgent {
  constructor({ repository, registry, renewalAgent = new RenewalAgent(), logger = null } = {}) {
    if (!repository || !registry) throw new Error('GateConversationAgent requer repository e tool registry.');
    this.repository = repository;
    this.registry = registry;
    this.renewalAgent = renewalAgent;
    this.logger = logger;
  }

  async process({
    conversationId,
    messageId,
    text,
    contentType = 'TEXT',
    identity,
    correlationId = randomUUID(),
    planCode = null
  }) {
    const idempotencyKey = `conversation:${conversationId}:${messageId}`;
    const existing = await this.repository.findDecision(idempotencyKey);
    if (existing) return resultFromStored(existing);

    const lease = await this.repository.claimTurn({
      conversationKey: conversationId,
      messageId
    });
    if (!lease.acquired) {
      return {
        contract: 'GateConversationTurn.v1', handled: true, duplicate: false,
        correlation_id: correlationId, outcome: 'TURN_IN_PROGRESS',
        response_status: 'SAFE_FALLBACK', response_facts: {},
        response_text: renderConversationResponse({ intent: 'UNKNOWN', outcome: 'TURN_IN_PROGRESS' })
      };
    }

    let customerId = null;
    let contextSnapshot = null;
    let intentResult = understandRequest(text, { contentType });
    let turns = [];
    let responseFacts = responseFactsFromContext(null);
    let proposedAction = null;
    let outcome = 'RESOLVED';
    let responseStatus = 'VALIDATED';
    let autonomous = true;
    let conversationState = null;

    try {
      if (intentResult.security_flags.includes('PROMPT_INJECTION')) {
        outcome = 'PROMPT_INJECTION_BLOCKED';
        responseStatus = 'SAFE_FALLBACK';
      } else {
        const discoveryTurn = this.registry.beginTurn({ intentResult });
        turns.push(discoveryTurn);
        const resolution = await discoveryTurn.execute('resolveCustomer', identity);
        if (resolution.status === 'MATCHED') customerId = resolution.customer_id;

        if (resolution.status === 'AMBIGUOUS') {
          const handoff = await discoveryTurn.execute('requestHumanHandoff', {
            conversation_id: conversationId,
            customer_id: null,
            correlation_id: correlationId,
            reason: 'IDENTITY_AMBIGUOUS',
            intent: intentResult,
            summary: 'Identidade ambígua; validar customer antes de qualquer consulta.',
            idempotency_key: `${idempotencyKey}:handoff`
          });
          responseFacts = mergeResponseFacts(responseFacts, { handoff_id: handoff.handoff_id });
          outcome = 'IDENTITY_AMBIGUOUS';
          autonomous = false;
          conversationState = 'human_handoff';
        } else if (!customerId) {
          if (['HUMAN_REQUEST', 'COMPLAINT', 'CANCELLATION_REQUEST'].includes(intentResult.primary_intent)) {
            const handoff = await discoveryTurn.execute('requestHumanHandoff', {
              conversation_id: conversationId,
              customer_id: null,
              correlation_id: correlationId,
              reason: intentResult.primary_intent,
              intent: intentResult,
              summary: 'Contato não identificado solicitou atendimento humano.',
              idempotency_key: `${idempotencyKey}:handoff`
            });
            responseFacts = mergeResponseFacts(responseFacts, { handoff_id: handoff.handoff_id });
            outcome = 'HANDOFF_CREATED';
            autonomous = false;
            conversationState = 'human_handoff';
          } else if (['PLAN_QUERY', 'NEW_CUSTOMER', 'TRIAL_REQUEST', 'REFERRAL'].includes(intentResult.primary_intent)) {
            const plans = await discoveryTurn.execute('listPlans', {});
            responseFacts = mergeResponseFacts(responseFacts, { plans });
            proposedAction = 'listPlans';
          } else {
            outcome = 'IDENTITY_REQUIRED';
            autonomous = false;
            conversationState = 'awaiting_login';
          }
        } else {
          contextSnapshot = await discoveryTurn.execute('getCustomerContext', {
            customer_id: customerId,
            purpose: contextPurpose(intentResult.primary_intent),
            requested_scopes: requestedScopes(intentResult.primary_intent),
            correlation_id: correlationId,
            channel: 'WHATSAPP'
          });
          const customer360 = contextSnapshot.customer360;
          responseFacts = responseFactsFromContext(customer360);
          const statefulIntent = understandRequest(text, {
            contentType,
            conversationState: customer360?.conversation?.state
          });
          if (intentResult.primary_intent === 'UNKNOWN' && statefulIntent.primary_intent !== 'UNKNOWN') {
            intentResult = statefulIntent;
          }
          const actionTurn = this.registry.beginTurn({ intentResult, customerId });
          turns.push(actionTurn);

          const renewalResult = await this.renewalAgent.handle({
            intentResult,
            customerId,
            customer360,
            turn: actionTurn,
            facts: responseFacts,
            context: {
              correlation_id: correlationId,
              idempotency_key: idempotencyKey,
              plan_code: planCode
            }
          });
          if (renewalResult.handled) {
            proposedAction = renewalResult.proposed_action;
            responseFacts = renewalResult.facts;
          } else if (intentResult.primary_intent === 'GREETING') {
            proposedAction = 'getCustomerContext';
          } else if (intentResult.primary_intent === 'SUPPORT_REQUEST') {
            const subscription = await actionTurn.execute('getSubscription', { customer_id: customerId });
            const renewal = await actionTurn.execute('getRenewalStatus', {
              customer_id: customerId,
              subscription_id: subscription.subscription_id
            });
            responseFacts = mergeResponseFacts(responseFacts, {
              subscription_status: subscription.status || responseFacts.subscription_status,
              expiration: subscription.expires_at || responseFacts.expiration,
              payment_status: renewal.payment_status || responseFacts.payment_status,
              renewal_status: renewal.renewal_status || responseFacts.renewal_status,
              operation_state: renewal.decision || null
            });
            const openCases = await actionTurn.execute('getOpenSupportCases', { customer_id: customerId });
            const support = openCases[0] || await actionTurn.execute('openSupportCase', {
              customer_id: customerId,
              category: 'TECHNICAL_SUPPORT',
              summary: 'Cliente relata falha de funcionamento pelo WhatsApp.',
              message: null,
              correlation_id: correlationId,
              idempotency_key: `${idempotencyKey}:support`
            });
            responseFacts = mergeResponseFacts(responseFacts, {
              support_case_id: support.support_case_id || support.id
            });
            proposedAction = openCases.length ? 'getOpenSupportCases' : 'openSupportCase';
          } else if (['HUMAN_REQUEST', 'COMPLAINT', 'CANCELLATION_REQUEST', 'REFERRAL'].includes(intentResult.primary_intent)) {
            const handoff = await actionTurn.execute('requestHumanHandoff', {
              conversation_id: conversationId,
              customer_id: customerId,
              context_snapshot_id: contextSnapshot.context_snapshot_id,
              correlation_id: correlationId,
              reason: intentResult.primary_intent,
              intent: intentResult,
              tools_used: actionTurn.calls,
              summary: `Handoff solicitado para ${intentResult.primary_intent}.`,
              idempotency_key: `${idempotencyKey}:handoff`
            });
            responseFacts = mergeResponseFacts(responseFacts, { handoff_id: handoff.handoff_id });
            proposedAction = 'requestHumanHandoff';
            outcome = 'HANDOFF_CREATED';
            autonomous = false;
            conversationState = 'human_handoff';
          } else if (intentResult.primary_intent === 'UNKNOWN') {
            outcome = 'CLARIFICATION_REQUIRED';
            autonomous = false;
          }
        }
      }
    } catch (error) {
      outcome = statusFromToolError(error);
      autonomous = false;
      if (outcome === 'CONFIRMATION_REQUIRED') {
        conversationState = 'confirmation_required';
      } else if (outcome === 'HUMAN_REQUIRED') {
        conversationState = 'human_handoff';
      }
      responseFacts = mergeResponseFacts(responseFacts, { error_code: error.code || 'AGENT_FAILURE' });
      if (['HUMAN_ACTION_REQUIRED', 'TOOL_TIMEOUT', 'PROVIDER_UNAVAILABLE'].includes(error.code)) {
        try {
          const handoffTurn = this.registry.beginTurn({ intentResult, customerId });
          turns.push(handoffTurn);
          const handoff = await handoffTurn.execute('requestHumanHandoff', {
            conversation_id: conversationId,
            customer_id: customerId,
            context_snapshot_id: contextSnapshot?.context_snapshot_id || null,
            correlation_id: correlationId,
            reason: error.code,
            intent: intentResult,
            tools_used: turns.flatMap((turn) => turn.calls),
            summary: 'Falha operacional requer continuidade humana com contexto preservado.',
            idempotency_key: `${idempotencyKey}:handoff`
          });
          responseFacts = mergeResponseFacts(responseFacts, { handoff_id: handoff.handoff_id });
          outcome = 'HANDOFF_CREATED';
          conversationState = 'human_handoff';
        } catch {
          outcome = 'HANDOFF_FAILED';
        }
      }
      this.logger?.warn?.({
        conversation_id: conversationId,
        customer_id: customerId,
        correlation_id: correlationId,
        intent: intentResult.primary_intent,
        error_code: error.code || 'AGENT_FAILURE'
      }, 'GateConversationAgent aplicou fallback seguro');
    }

    try {
      let responseText = renderConversationResponse({
        intent: intentResult.primary_intent,
        facts: responseFacts,
        outcome
      });
      let validation = validateConversationResponse(responseText, responseFacts);
      if (!validation.allowed) {
        responseText = safeResponseForFacts(responseFacts);
        validation = validateConversationResponse(responseText, responseFacts);
        responseStatus = 'SAFE_FALLBACK';
        outcome = 'RESPONSE_VALIDATION_FALLBACK';
      }
      const repeated = avoidRepeatedResponse(
        responseText,
        contextSnapshot?.customer360?.conversation?.recent_messages || []
      );
      responseText = repeated.text;
      if (repeated.repeated) outcome = 'ANTI_REPETITION_FALLBACK';

      const toolCalls = turns.flatMap((turn) => turn.calls);
      const policyResult = toolCalls.some((call) => call.policy === 'DENY')
        ? 'DENY'
        : toolCalls.some((call) => call.policy === 'REQUIRE_HUMAN')
          ? 'REQUIRE_HUMAN'
          : toolCalls.some((call) => call.policy === 'REQUIRE_CONFIRMATION')
            ? 'REQUIRE_CONFIRMATION'
            : 'ALLOW';
      const recorded = await this.repository.recordDecision({
        conversation_id: conversationId,
        customer_id: customerId,
        context_snapshot_id: contextSnapshot?.context_snapshot_id || null,
        message_id: messageId,
        correlation_id: correlationId,
        intents: intentResult.intents,
        confidence: intentResult.confidence,
        proposed_action: proposedAction,
        policy_result: policyResult,
        response_status: responseStatus,
        response_facts: responseFacts,
        response_text: responseText,
        outcome,
        prompt_version: GATE_CONVERSATION_AGENT_PROMPT_VERSION,
        autonomous,
        eligible_for_automation: AUTOMATION_ELIGIBLE.has(intentResult.primary_intent),
        idempotency_key: idempotencyKey,
        tool_calls: toolCalls
      });
      this.logger?.info?.({
        decision_id: recorded.decision_id,
        conversation_id: conversationId,
        customer_id: customerId,
        context_snapshot_id: contextSnapshot?.context_snapshot_id || null,
        correlation_id: correlationId,
        intent: intentResult.primary_intent,
        confidence: intentResult.confidence,
        policy: policyResult,
        tool: proposedAction,
        result: outcome,
        response_status: responseStatus
      }, 'Turno processado pelo GateConversationAgent');
      return {
        contract: 'GateConversationTurn.v1',
        handled: true,
        duplicate: false,
        decision_id: recorded.decision_id,
        customer_id: customerId,
        context_snapshot_id: contextSnapshot?.context_snapshot_id || null,
        correlation_id: correlationId,
        intent: intentResult.primary_intent,
        intents: intentResult.intents,
        confidence: intentResult.confidence,
        proposed_action: proposedAction,
        policy_result: policyResult,
        response_status: responseStatus,
        response_facts: responseFacts,
        response_text: responseText,
        outcome,
        conversation_state: conversationState,
        tool_calls: toolCalls.map((call) => ({
          tool: call.tool,
          status: call.status,
          policy: call.policy,
          error_code: call.error_code || null
        }))
      };
    } finally {
      await this.repository.releaseTurn(conversationId, lease.token).catch(() => false);
    }
  }
}
