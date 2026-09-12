import { randomUUID } from 'node:crypto';
import { createBusinessEvent } from '../core/events.js';
import { notificationRequested } from '../core/notifications.js';
import {
  SUPPORT_LIMITS,
  triageSupport,
  transitionCase,
  transitionException,
  exceptionPriority,
  knowledgeMetrics,
  supportError,
} from '../core/support.js';
import { assertLocalSupport } from './support-repository.js';

const AGENT = Object.freeze({ type: 'AGENT', id: 'support-agent' });
const terminal = (row) => ['RESOLVED', 'CLOSED'].includes(row.status);
const redact = (value) =>
  String(value || '')
    .slice(0, 2000)
    .replace(/\b(senha|password|token|secret)\s*[:=]\s*\S+/gi, '$1: [REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
function contextEvidence(context) {
  // Only existing Customer360 projections, never prompt state, credentials or raw message history.
  return structuredClone({
    contract: context.contract,
    customer_id: context.customer_id,
    identity: { name: context.identity?.name },
    lifecycle: context.lifecycle,
    subscription: context.subscription,
    financial: context.financial,
    renewal: context.renewal,
    support: context.support,
    conversation: context.conversation
      ? {
          conversation_id: context.conversation.conversation_id,
          state: context.conversation.state,
          handoff_status: context.conversation.handoff_status,
        }
      : null,
  });
}
export class SupportOperations {
  constructor({
    repository,
    env = process.env,
    now = () => new Date(),
    logger = null,
  }) {
    assertLocalSupport(env);
    this.repository = repository;
    this.env = env;
    this.now = now;
    this.logger = logger;
  }
  stamp() {
    return this.now().toISOString();
  }
  async event(tx, type, row, before = null, actor = AGENT) {
    const event = createBusinessEvent({
      eventType: type,
      occurredAt: this.stamp(),
      correlationId: row.correlation_id,
      actor,
      subject: {
        type: type.startsWith('exception.') ? 'exception' : 'support_case',
        id: row.id,
      },
      payload: {
        customer_id: row.customer_id,
        support_case_id: row.support_case_id || row.id,
        conversation_id: row.conversation_id,
        status: row.status,
        reason_code: row.reason_code,
      },
    });
    await tx.emit(event, before, row);
    this.logger?.info?.(
      {
        support_case_id: row.support_case_id || row.id,
        exception_id: type.startsWith('exception.') ? row.id : null,
        customer_id: row.customer_id,
        conversation_id: row.conversation_id,
        agent: actor.id,
        intent: row.intent,
        category: row.category,
        severity: row.severity,
        result: row.status,
        transaction_state: 'PENDING_COMMIT',
        correlation_id: row.correlation_id,
      },
      type,
    );
  }
  async prepare(input) {
    assertLocalSupport(this.env);
    if (
      input.context?.customer_id !== input.customer_id ||
      input.context?.contract !== 'Customer360.v1'
    )
      throw supportError('CROSS_CUSTOMER_CONTEXT');
    return this.repository.transaction(input.customer_id, async (tx) => {
      const replay = (
        await tx.list(
          'receipts',
          {
            customer_id: input.customer_id,
            idempotency_key: input.idempotency_key,
          },
          { limit: 1 },
        )
      )[0];
      if (replay)
        return tx.get('cases', replay.support_case_id, input.customer_id);
      const previous = await tx.list(
        'cases',
        { customer_id: input.customer_id },
        { limit: 100 },
      );
      const probe = (
        await tx.list(
          'probes',
          { customer_id: input.customer_id },
          { limit: 1 },
        )
      )[0];
      if (
        Object.values(input.operational || {}).some(
          (value) =>
            value?.customer_id && value.customer_id !== input.customer_id,
        )
      )
        throw supportError('CROSS_CUSTOMER_CONTEXT');
      const triageContext = input.operational
        ? {
            ...input.context,
            subscription: input.operational.subscription,
            financial: {
              ...input.context.financial,
              reconciliation_status:
                input.operational.payment?.reconciliation_status,
            },
            renewal: input.operational.renewal,
          }
        : input.context;
      const triage = triageSupport({
        text: input.text,
        context: triageContext,
        intent: input.intent,
        probe,
        attempts: previous[0]?.attempts?.length || 0,
      });
      const active = await tx.activeCase(input.customer_id, triage.category);
      const legacy = active ? null : await tx.legacyCase(input.customer_id);
      let row = active || {
        id: legacy?.id || randomUUID(),
        customer_id: input.customer_id,
        conversation_id: input.conversation_id,
        category: triage.category,
        severity: triage.severity,
        status: 'OPEN',
        summary: redact(input.text),
        diagnosis: triage.problem_code,
        resolution: null,
        confidence: triage.confidence,
        automation_eligible: triage.automation_eligibility,
        assigned_to: null,
        created_at: legacy?.created_at?.toISOString() || this.stamp(),
        resolved_at: null,
        correlation_id: input.correlation_id,
        context_snapshot_id: input.context_snapshot_id,
        context: {
          ...contextEvidence(input.context),
          operational: input.operational,
        },
        triage,
        intent: input.intent,
        attempts: [],
        tool_calls: 0,
        agent_turns: 0,
        human_intervention: false,
        previous_case_id: previous.find(terminal)?.id || null,
      };
      const before = structuredClone(row);
      row.agent_turns++;
      row.updated_at = this.stamp();
      row.tool_calls +=
        1 + Math.min(12, Math.max(0, Number(input.observed_tool_calls) || 0));
      if (active) {
        // Eligibility at opening is immutable for metrics; execution eligibility is re-evaluated.
        row.triage = triage;
        row.confidence = triage.confidence;
        row.context = {
          ...contextEvidence(input.context),
          operational: input.operational,
        };
        row.context_snapshot_id = input.context_snapshot_id;
        row.last_summary = redact(input.text);
        row.correlation_id = input.correlation_id;
        if (
          ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(triage.severity) >
          ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(row.severity)
        )
          row.severity = triage.severity;
      }
      if (row.status === 'OPEN') {
        await this.event(tx, 'support.case_opened', row);
        row = transitionCase(row, 'TRIAGING');
      } else if (['WAITING_CUSTOMER', 'WAITING_SYSTEM'].includes(row.status))
        row = transitionCase(row, 'TRIAGING');
      if (
        row.agent_turns > SUPPORT_LIMITS.max_agent_turns ||
        row.tool_calls > SUPPORT_LIMITS.max_tool_calls
      )
        row.limit_reached = true;
      await tx.put('cases', row);
      await tx.put('receipts', {
        id: randomUUID(),
        customer_id: row.customer_id,
        idempotency_key: input.idempotency_key,
        support_case_id: row.id,
        updated_at: this.stamp(),
      });
      await this.event(tx, 'support.triaged', row, before);
      const count = await tx.incidentCount(
        row.diagnosis,
        new Date(this.now().getTime() - 15 * 60000).toISOString(),
      );
      if (count >= 20) {
        const window_key = `${row.diagnosis}:${Math.floor(this.now().getTime() / (15 * 60000))}`;
        const existing = (
          await tx.list('incidents', { window_key }, { limit: 1 })
        )[0];
        const incident = {
          ...(existing || {
            id: randomUUID(),
            window_key,
            created_at: this.stamp(),
            status: 'CANDIDATE',
          }),
          problem_pattern: row.diagnosis,
          distinct_customers: count,
          updated_at: this.stamp(),
        };
        await tx.put('incidents', incident);
        row.incident_candidate_id = incident.id;
        row.triage.recommended_action = 'INCIDENT_REVIEW';
        row.triage.customer_impact = 'MULTIPLE_CUSTOMERS';
        if (['LOW', 'MEDIUM'].includes(row.severity)) row.severity = 'HIGH';
        await tx.put('cases', row);
        if (!existing)
          await tx.emit(
            createBusinessEvent({
              eventType: 'support.incident_candidate',
              correlationId: row.correlation_id,
              actor: AGENT,
              subject: { type: 'incident_candidate', id: incident.id },
              payload: {
                problem_pattern: row.diagnosis,
                distinct_customers: count,
              },
            }),
            null,
            incident,
          );
      }
      return row;
    });
  }
  async knownSolution(input) {
    return this.repository.transaction(input.customer_id, async (tx) => {
      const row = await this.case(tx, input);
      row.tool_calls++;
      row.updated_at = this.stamp();
      await tx.put('cases', row);
      const solutions = await tx.list(
        'knowledge',
        { problem_pattern: row.diagnosis, validation_status: 'VALIDATED' },
        { limit: 100 },
      );
      const solution = solutions.find(
        (k) =>
          !k.customer_id &&
          !k.review_required &&
          k.confidence >= 0.8 &&
          k.solution === 'REFRESH_SYNTHETIC_SESSION',
      );
      return {
        customer_id: row.customer_id,
        knowledge_id: solution?.id || null,
        status: solution ? 'FOUND' : 'NOT_FOUND',
      };
    });
  }
  async case(tx, input) {
    return tx.get('cases', input.support_case_id, input.customer_id);
  }
  async execute(input) {
    assertLocalSupport(this.env);
    return this.repository.transaction(input.customer_id, async (tx) => {
      const row = await this.case(tx, input);
      const duplicate = (
        await tx.list(
          'receipts',
          {
            customer_id: input.customer_id,
            idempotency_key: input.idempotency_key,
          },
          { limit: 1 },
        )
      )[0];
      if (duplicate) {
        if (duplicate.support_case_id !== row.id)
          throw supportError('IDEMPOTENCY_CONFLICT');
        return duplicate;
      }
      if (
        !row.automation_eligible ||
        !row.triage.automation_eligibility ||
        row.confidence < 0.8 ||
        row.limit_reached ||
        row.human_intervention ||
        !['TRIAGING', 'AUTOMATED_RESOLUTION'].includes(row.status)
      )
        throw supportError('SUPPORT_POLICY_DENIED');
      if (
        row.attempts.length >= row.triage.max_resolution_attempts ||
        row.tool_calls >= SUPPORT_LIMITS.max_tool_calls
      )
        throw supportError('SUPPORT_LOOP_LIMIT');
      const knowledge = await tx.get('knowledge', input.knowledge_id);
      if (
        knowledge.customer_id ||
        knowledge.problem_pattern !== row.diagnosis ||
        knowledge.validation_status !== 'VALIDATED' ||
        knowledge.review_required ||
        knowledge.confidence < 0.8 ||
        knowledge.solution !== 'REFRESH_SYNTHETIC_SESSION'
      )
        throw supportError('UNVALIDATED_KNOWLEDGE');
      const probe = (
        await tx.list('probes', { customer_id: row.customer_id }, { limit: 1 })
      )[0];
      if (!probe?.synthetic || probe.problem_code !== 'STALE_SESSION')
        throw supportError('SYNTHETIC_PROVIDER_REQUIRED');
      const before = structuredClone(row);
      if (row.status === 'TRIAGING')
        Object.assign(row, transitionCase(row, 'AUTOMATED_RESOLUTION'));
      const receipt = {
        id: randomUUID(),
        customer_id: row.customer_id,
        support_case_id: row.id,
        knowledge_id: knowledge.id,
        idempotency_key: input.idempotency_key,
        action_performed: 'REFRESH_SYNTHETIC_SESSION',
        verification_result: 'NOT_VERIFIED',
        status: 'EXECUTED',
        updated_at: this.stamp(),
      };
      // The fake action changes provider state; VERIFY reads it in a separate transaction.
      await tx.put('probes', {
        ...probe,
        healthy: !probe.fail_action,
        revision: (probe.revision || 0) + 1,
        updated_at: this.stamp(),
      });
      row.attempts.push({
        receipt_id: receipt.id,
        tool: 'executeSupportAction',
        action: receipt.action_performed,
        result: 'EXECUTED',
        timestamp: this.stamp(),
      });
      row.tool_calls++;
      row.updated_at = this.stamp();
      await tx.put('cases', row);
      await tx.put('receipts', receipt);
      await this.event(tx, 'support.resolution_attempted', row, before);
      return receipt;
    });
  }
  async verify(input) {
    return this.repository.transaction(input.customer_id, async (tx) => {
      const row = await this.case(tx, input);
      const receipt = await tx.get(
        'receipts',
        input.receipt_id,
        input.customer_id,
      );
      if (receipt.support_case_id !== row.id)
        throw supportError('CROSS_CASE_RECEIPT');
      if (receipt.verification_result !== 'NOT_VERIFIED') return receipt;
      const probe = (
        await tx.list('probes', { customer_id: row.customer_id }, { limit: 1 })
      )[0];
      receipt.verification_result = probe?.unverifiable
        ? 'UNVERIFIABLE'
        : probe?.synthetic && probe.healthy === true
          ? 'VERIFIED'
          : 'FAILED';
      receipt.verified_at = this.stamp();
      receipt.updated_at = this.stamp();
      const knowledge = await tx.get('knowledge', receipt.knowledge_id);
      await tx.put(
        'knowledge',
        knowledgeMetrics(
          knowledge,
          receipt.verification_result === 'VERIFIED',
          this.stamp(),
        ),
      );
      row.attempts.find((a) => a.receipt_id === receipt.id).result =
        receipt.verification_result;
      row.tool_calls++;
      row.updated_at = this.stamp();
      await tx.put('cases', row);
      await tx.put('receipts', receipt);
      await this.event(tx, 'support.verification_recorded', row);
      return receipt;
    });
  }
  async record(input) {
    return this.repository.transaction(input.customer_id, async (tx) => {
      let row = await this.case(tx, input);
      if (row.status === 'RESOLVED') return this.facts(row);
      const receipt = await tx.get(
        'receipts',
        input.receipt_id,
        input.customer_id,
      );
      if (receipt.support_case_id !== row.id)
        throw supportError('CROSS_CASE_RECEIPT');
      if (!['VERIFIED', 'UNVERIFIABLE'].includes(receipt.verification_result))
        throw supportError('VERIFICATION_REQUIRED');
      const before = structuredClone(row);
      row = transitionCase(
        row,
        receipt.verification_result === 'VERIFIED'
          ? 'RESOLVED'
          : 'WAITING_CUSTOMER',
        { verified: receipt.verification_result === 'VERIFIED' },
      );
      row.verification_result = receipt.verification_result;
      row.action_performed = receipt.action_performed;
      row.resolution =
        receipt.verification_result === 'VERIFIED'
          ? 'SYNTHETIC_SERVICE_HEALTHY'
          : null;
      row.resolved_at = row.status === 'RESOLVED' ? this.stamp() : null;
      row.first_response_at ||= this.stamp();
      row.updated_at = this.stamp();
      row.tool_calls++;
      await tx.put('cases', row);
      await tx.updateConversation(row);
      await this.event(
        tx,
        row.status === 'RESOLVED'
          ? 'support.case_resolved'
          : 'support.waiting_customer',
        row,
        before,
      );
      if (row.status === 'RESOLVED')
        await tx.put('knowledge', {
          id: randomUUID(),
          customer_id: row.customer_id,
          category: row.category,
          problem_pattern: row.diagnosis,
          solution: receipt.action_performed,
          validation_status: 'CANDIDATE',
          source: { type: 'VERIFIED_SUPPORT_CASE', id: row.id },
          attempt_count: 0,
          success_count: 0,
          failure_count: 0,
          confidence: 0,
          created_at: this.stamp(),
          updated_at: this.stamp(),
          last_validated_at: null,
        });
      await this.notification(tx, row, 'SUPPORT_STATE_UPDATED');
      return this.facts(row);
    });
  }
  facts(row) {
    return {
      customer_id: row.customer_id,
      support_case_id: row.id,
      case_status: row.status,
      diagnosis: row.diagnosis,
      action_performed: row.action_performed || null,
      verification_result: row.verification_result || 'NOT_VERIFIED',
      exception_id: row.exception_id || null,
      automation_eligible: row.automation_eligible,
    };
  }
  async notification(tx, row, intention) {
    const n = notificationRequested({
      customerId: row.customer_id,
      channel: 'IN_APP',
      intention,
      context: this.facts(row),
      correlationId: row.correlation_id,
    });
    await tx.notify(n);
    await tx.emit(
      createBusinessEvent({
        eventType: 'notification.requested',
        correlationId: row.correlation_id,
        actor: AGENT,
        subject: { type: 'notification', id: n.notification_id },
        payload: n,
      }),
      null,
      { status: 'PENDING', correlation_id: row.correlation_id },
    );
  }
  async handoff(input) {
    return this.repository.transaction(input.customer_id, async (tx) => {
      let row = await this.case(tx, input);
      const before = structuredClone(row);
      const dedup_key = `${row.id}:${row.diagnosis}`;
      const existing = (
        await tx.list(
          'exceptions',
          { customer_id: row.customer_id, dedup_key },
          { limit: 100 },
        )
      ).find((e) => !['RESOLVED', 'DISMISSED'].includes(e.status));
      if (terminal(row))
        return { ...this.facts(row), handoff_id: existing?.id || null };
      if (row.status !== 'HUMAN_REQUIRED')
        row = transitionCase(row, 'HUMAN_REQUIRED');
      row.human_intervention = true;
      row.first_response_at ||= this.stamp();
      row.updated_at = this.stamp();
      row.tool_calls++;
      const reason = redact(input.reason || row.triage.recommended_action);
      const exception = existing || {
        id: randomUUID(),
        customer_id: row.customer_id,
        support_case_id: row.id,
        conversation_id: row.conversation_id,
        domain: 'SUPPORT',
        type: reason,
        category: row.category,
        severity: row.severity,
        reason_code: reason,
        summary: row.summary,
        context_snapshot_id: row.context_snapshot_id,
        context: row.context,
        diagnosis: row.diagnosis,
        attempts: row.attempts,
        tools_used: row.attempts.map((a) => a.tool),
        risk: row.triage.customer_impact,
        recommended_action:
          'Revisar o contexto e validar o resultado com o cliente antes de resolver.',
        possible_action: 'VERIFIED_HUMAN_RESOLUTION',
        dedup_key,
        status: 'OPEN',
        created_at: this.stamp(),
        claimed_at: null,
        resolved_at: null,
        resolved_by: null,
        correlation_id: row.correlation_id,
        repetitions: 0,
        financial_risk: reason === 'FINANCIAL_DIVERGENCE',
        security_risk: reason === 'SECURITY_REVIEW',
        churn_risk: row.triage.dissatisfied,
      };
      exception.repetitions++;
      exception.updated_at = this.stamp();
      exception.priority = exceptionPriority(exception, this.now().getTime());
      exception.attempts = structuredClone(row.attempts);
      exception.tools_used = (input.tools_used || [])
        .slice(0, 12)
        .map((call) => ({
          tool: call.tool,
          status: call.status,
          policy: call.policy,
          error_code: call.error_code || null,
          result: call.result || null,
        }));
      exception.context = row.context;
      exception.context_snapshot_id = row.context_snapshot_id;
      exception.severity = row.severity;
      exception.incident_candidate_id = row.incident_candidate_id || null;
      row.exception_id = exception.id;
      await tx.put('cases', row);
      await tx.put('exceptions', exception);
      await tx.updateConversation(row);
      if (!existing) {
        await this.event(tx, 'exception.created', exception);
        await this.notification(tx, row, 'HUMAN_REQUIRED');
      }
      await this.event(tx, 'support.human_required', row, before);
      return {
        ...this.facts(row),
        handoff_id: exception.id,
        status: 'REQUESTED',
      };
    });
  }
  async humanAction({
    customer_id,
    exception_id,
    action,
    note,
    result,
    actor,
    correlation_id,
  }) {
    if (actor?.type !== 'ADMIN' || !actor.id)
      throw supportError('HUMAN_ACTOR_REQUIRED');
    return this.repository.transaction(customer_id, async (tx) => {
      let e = await tx.get('exceptions', exception_id, customer_id);
      let row = await tx.get('cases', e.support_case_id, customer_id);
      const before = structuredClone(e);
      const states = {
        claim: 'IN_PROGRESS',
        wait: 'WAITING_CUSTOMER',
        resolve: 'RESOLVED',
        dismiss: 'DISMISSED',
      };
      if (!states[action]) throw supportError('ACTION_NOT_ALLOWLISTED');
      if (e.resolved_by && e.resolved_by !== actor.id)
        throw supportError('EXCEPTION_CLOSED');
      if (e.claimed_by && e.claimed_by !== actor.id)
        throw supportError('EXCEPTION_CLAIMED');
      if (
        action === 'resolve' &&
        (result !== 'VERIFIED' || String(note || '').trim().length < 10)
      )
        throw supportError('HUMAN_VERIFICATION_REQUIRED');
      if (action === 'dismiss' && String(note || '').trim().length < 10)
        throw supportError('REASON_REQUIRED');
      e = transitionException(e, states[action]);
      e.updated_at = this.stamp();
      e.correlation_id = correlation_id;
      e.human_result = {
        actor,
        action,
        result: result || action,
        note: redact(note),
        timestamp: this.stamp(),
        correlation_id,
      };
      if (action === 'claim') {
        e.claimed_at = this.stamp();
        e.claimed_by = actor.id;
        row.assigned_to = actor.id;
      }
      if (action === 'resolve') {
        e.resolved_at = this.stamp();
        e.resolved_by = actor.id;
        row = transitionCase(row, 'RESOLVED', { verified: true, human: true });
        row.resolution = redact(note);
        row.verification_result = 'HUMAN_VERIFIED';
        row.resolved_at = this.stamp();
      }
      if (
        ['wait', 'dismiss'].includes(action) &&
        row.status !== 'WAITING_CUSTOMER'
      )
        row = transitionCase(row, 'WAITING_CUSTOMER');
      row.human_intervention = true;
      row.updated_at = this.stamp();
      row.correlation_id = correlation_id;
      await tx.put('exceptions', e);
      await tx.put('cases', row);
      await tx.updateConversation(row);
      await this.event(
        tx,
        action === 'resolve'
          ? 'exception.resolved'
          : action === 'claim'
            ? 'exception.acknowledged'
            : 'exception.updated',
        e,
        before,
        actor,
      );
      if (action === 'resolve')
        await this.event(tx, 'support.case_resolved', row, null, actor);
      await this.notification(tx, row, 'SUPPORT_HUMAN_UPDATED');
      return e;
    });
  }
  handlers() {
    return {
      prepareSupportCase: (i) => this.prepare(i),
      getValidatedSolution: (i) => this.knownSolution(i),
      executeSupportAction: (i) => this.execute(i),
      verifySupportResult: (i) => this.verify(i),
      recordResolutionResult: (i) => this.record(i),
      escalateSupportCase: (i) => this.handoff(i),
    };
  }
}
