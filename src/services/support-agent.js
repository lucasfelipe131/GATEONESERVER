import { mergeResponseFacts } from '../core/conversation-responses.js';

// Specialization of GateConversationAgent: no repository, provider, network or admin access.
export class SupportAgent {
  async handle({
    turn,
    customerId,
    customer360,
    intentResult,
    text,
    conversationId,
    contextSnapshotId,
    correlationId,
    idempotencyKey,
    facts,
  }) {
    let operational = null;
    let observationFailure = null;
    if (intentResult.primary_intent === 'SUPPORT_REQUEST') {
      operational = {};
      try {
        operational.subscription = await turn.execute('getSubscription', {
          customer_id: customerId,
        });
        operational.payment = await turn.execute('getPaymentStatus', {
          customer_id: customerId,
        });
        operational.renewal = await turn.execute('getRenewalStatus', {
          customer_id: customerId,
        });
      } catch (error) {
        observationFailure = error.code || 'SUPPORT_OBSERVATION_FAILED';
        operational.error_code = observationFailure;
      }
    }
    const support = await turn.execute('prepareSupportCase', {
      customer_id: customerId,
      context: customer360,
      text,
      intent: intentResult.primary_intent,
      operational,
      observed_tool_calls: turn.calls.length,
      conversation_id: conversationId,
      context_snapshot_id: contextSnapshotId,
      correlation_id: correlationId,
      idempotency_key: `${idempotencyKey}:support-prepare`,
    });
    const common = {
      customer_id: customerId,
      support_case_id: support.id,
      conversation_id: conversationId,
      correlation_id: correlationId,
    };
    if (['RESOLVED', 'CLOSED'].includes(support.status))
      return {
        facts: mergeResponseFacts(facts, {
          support_case_id: support.id,
          case_status: support.status,
          diagnosis: support.diagnosis,
          action_performed: support.action_performed,
          verification_result: support.verification_result,
        }),
        outcome: 'RESOLVED',
        autonomous: !support.human_intervention,
        conversationState: 'support_resolved',
        eligible: support.automation_eligible,
      };
    const escalate = async (reason) => {
      const result = await turn.execute('escalateSupportCase', {
        ...common,
        reason,
        tools_used: turn.calls,
        idempotency_key: `${idempotencyKey}:support-handoff`,
      });
      return {
        facts: mergeResponseFacts(facts, result),
        outcome: 'HANDOFF_CREATED',
        autonomous: false,
        conversationState: 'human_handoff',
        eligible: support.automation_eligible,
      };
    };
    if (support.limit_reached) return escalate('SUPPORT_LOOP_LIMIT');
    if (observationFailure) return escalate(observationFailure);
    if (support.incident_candidate_id) return escalate('INCIDENT_REVIEW');
    if (
      ['HUMAN_REQUEST', 'COMPLAINT', 'CANCELLATION_REQUEST'].includes(
        intentResult.primary_intent,
      )
    )
      return escalate(intentResult.primary_intent);
    if (support.status === 'HUMAN_REQUIRED')
      return escalate('HUMAN_ALREADY_REQUESTED');
    if (!support.automation_eligible || !support.triage.automation_eligibility)
      return escalate(support.triage.recommended_action);
    if (support.confidence < 0.8) return escalate('LOW_CONFIDENCE');
    try {
      const knowledge = await turn.execute('getValidatedSolution', common);
      if (!knowledge.knowledge_id) return escalate('NO_VALIDATED_SOLUTION');
      // Max 2 attempts, no recursion; reserve the final registry call for handoff.
      const resume =
        support.attempts.at(-1)?.result === 'EXECUTED'
          ? support.attempts.length - 1
          : support.attempts.length;
      for (
        let attempt = resume;
        attempt < support.triage.max_resolution_attempts;
        attempt++
      ) {
        const action = await turn.execute('executeSupportAction', {
          ...common,
          knowledge_id: knowledge.knowledge_id,
          idempotency_key: `${support.id}:action:${attempt}`,
        });
        const verification = await turn.execute('verifySupportResult', {
          ...common,
          receipt_id: action.id,
        });
        if (
          ['VERIFIED', 'UNVERIFIABLE'].includes(
            verification.verification_result,
          )
        ) {
          const result = await turn.execute('recordResolutionResult', {
            ...common,
            receipt_id: action.id,
          });
          return {
            facts: mergeResponseFacts(facts, result),
            outcome:
              result.case_status === 'RESOLVED'
                ? 'RESOLVED'
                : 'WAITING_CUSTOMER',
            autonomous: result.case_status === 'RESOLVED',
            conversationState:
              result.case_status === 'RESOLVED'
                ? 'support_resolved'
                : 'waiting_customer',
            eligible: support.automation_eligible,
          };
        }
      }
      return escalate('REPEATED_FAILURE');
    } catch (error) {
      return escalate(error.code || 'UNKNOWN_FAILURE');
    }
  }
}
