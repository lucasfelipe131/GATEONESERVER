import { randomUUID } from 'node:crypto';
import { createBusinessEvent } from '../core/events.js';
import { appendOutboxEvent } from '../core/outbox.js';

export class PgConversationAgentRepository {
  constructor(db) { this.db = db; }

  async recentDecisions(conversationId, customerId) {
    const result = await this.db.query(`SELECT intents, outcome, response_text, response_facts
      FROM agent_decisions WHERE conversation_id = $1 AND customer_id IS NOT DISTINCT FROM $2::uuid
      AND created_at > now() - interval '24 hours' ORDER BY created_at DESC, decision_id DESC LIMIT 5`, [conversationId,customerId]);
    return result.rows;
  }

  async activeHandoff(conversationId, customerId) {
    const result = await this.db.query(`SELECT handoff_id,status FROM conversation_handoffs
      WHERE conversation_id = $1 AND (customer_id IS NOT DISTINCT FROM $2::uuid OR customer_id IS NULL)
      AND status IN ('REQUESTED','ASSIGNED') ORDER BY requested_at DESC LIMIT 1`, [conversationId,customerId]);
    if(result.rows[0]) return result.rows[0];
    const phone=/^whatsapp:(\+?\d{10,15})$/.exec(conversationId)?.[1]?.replace(/\D/g,'');
    if(!phone) return null;
    const legacy=await this.db.query(`SELECT 1 FROM conversation_sessions cs WHERE
      regexp_replace(cs.whatsapp_e164,'[^0-9]','','g')=$1 AND cs.state='support' AND cs.expires_at>now()
      AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM customers c WHERE c.id=$2 AND regexp_replace(COALESCE(c.whatsapp_e164,''),'[^0-9]','','g')=$1))
      AND NOT EXISTS(SELECT 1 FROM conversation_handoffs h WHERE h.conversation_id=$3 AND (h.customer_id IS NOT DISTINCT FROM $2::uuid OR h.customer_id IS NULL))`,
      [phone,customerId,conversationId]);
    if(!legacy.rowCount) return null;
    return this.requestHandoff({conversation_id:conversationId,customer_id:customerId,correlation_id:randomUUID(),
      reason:'LEGACY_HUMAN_HANDOFF_PRESERVED',idempotency_key:`legacy-handoff:${conversationId}:${customerId||'unknown'}`,
      requested_by:{type:'SYSTEM',id:'gate-handoff-migration'}});
  }

  async findDecision(idempotencyKey) {
    const result = await this.db.query(
      `SELECT decision_id, response_text, response_facts, response_status, outcome,
              customer_id, context_snapshot_id, correlation_id
         FROM agent_decisions WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    return result.rows[0] || null;
  }

  async claimTurn({ conversationKey, messageId, customerId = null, leaseMs = 30_000 }) {
    const claimToken = randomUUID();
    const result = await this.db.query(
      `INSERT INTO conversation_turn_leases
        (conversation_key, claim_token, message_id, customer_id, claim_until)
       VALUES ($1, $2, $3, $4, now() + ($5::text || ' milliseconds')::interval)
       ON CONFLICT (conversation_key) DO UPDATE
         SET claim_token = EXCLUDED.claim_token,
             message_id = EXCLUDED.message_id,
             customer_id = COALESCE(EXCLUDED.customer_id, conversation_turn_leases.customer_id),
             claim_until = EXCLUDED.claim_until,
             updated_at = now()
       WHERE conversation_turn_leases.claim_until < now()
       RETURNING claim_token, claim_until`,
      [conversationKey, claimToken, messageId, customerId, leaseMs]
    );
    return result.rows[0] ? { acquired: true, token: claimToken, claim_until: result.rows[0].claim_until } : { acquired: false };
  }

  async releaseTurn(conversationKey, token) {
    const result = await this.db.query(
      'DELETE FROM conversation_turn_leases WHERE conversation_key = $1 AND claim_token = $2',
      [conversationKey, token]
    );
    return result.rowCount > 0;
  }

  async requestHandoff(input) {
    const handoffId = input.handoff_id || randomUUID();
    return this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`handoff:${input.conversation_id}`]);
      const active = await client.query(`SELECT handoff_id,status FROM conversation_handoffs
        WHERE conversation_id = $1 AND (customer_id IS NOT DISTINCT FROM $2::uuid OR customer_id IS NULL)
        AND status IN ('REQUESTED','ASSIGNED') LIMIT 1`, [input.conversation_id,input.customer_id || null]);
      if (active.rows[0]) return {...active.rows[0],duplicate:true};
      const result = await client.query(
        `INSERT INTO conversation_handoffs
          (handoff_id, conversation_id, customer_id, context_snapshot_id, correlation_id,
           reason, intent, tools_used, summary, requested_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11)
         ON CONFLICT (idempotency_key) DO UPDATE
           SET updated_at = conversation_handoffs.updated_at
         RETURNING handoff_id, status, (xmax = 0) AS inserted`,
        [handoffId, input.conversation_id, input.customer_id || null,
          input.context_snapshot_id || null, input.correlation_id, input.reason,
          JSON.stringify(input.intent || null), JSON.stringify(input.tools_used || []),
          input.summary || null, JSON.stringify(input.requested_by || { type: 'AGENT', id: 'gate-conversation-agent' }),
          input.idempotency_key]
      );
      const row = result.rows[0];
      if (row.inserted) {
        await appendOutboxEvent(client, createBusinessEvent({
          eventType: 'conversation.handoff_requested',
          correlationId: input.correlation_id,
          actor: input.requested_by || { type: 'AGENT', id: 'gate-conversation-agent' },
          subject: { type: 'conversation_handoff', id: row.handoff_id },
          payload: {
            customer_id: input.customer_id || null,
            conversation_id: input.conversation_id,
            reason: input.reason
          }
        }));
      }
      return { handoff_id: row.handoff_id, status: row.status, duplicate: !row.inserted };
    });
  }

  async recordDecision(input) {
    return this.db.transaction(async (client) => {
      const decisionId = input.decision_id || randomUUID();
      const inserted = await client.query(
        `INSERT INTO agent_decisions
          (decision_id, conversation_id, customer_id, context_snapshot_id, message_id,
           correlation_id, intents, confidence, proposed_action, policy_result,
           response_status, response_facts, response_text, outcome, prompt_version,
           autonomous, eligible_for_automation, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
                 $12::jsonb, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING decision_id`,
        [decisionId, input.conversation_id, input.customer_id || null,
          input.context_snapshot_id || null, input.message_id, input.correlation_id,
          JSON.stringify(input.intents), input.confidence, input.proposed_action || null,
          input.policy_result, input.response_status, JSON.stringify(input.response_facts || {}),
          input.response_text, input.outcome, input.prompt_version,
          Boolean(input.autonomous), Boolean(input.eligible_for_automation), input.idempotency_key]
      );
      if (!inserted.rowCount) {
        const existing = await client.query(
          `SELECT decision_id, response_text, response_facts, response_status, outcome,
                  customer_id, context_snapshot_id, correlation_id
             FROM agent_decisions WHERE idempotency_key = $1`,
          [input.idempotency_key]
        );
        return existing.rows[0] || null;
      }
      for (let index = 0; index < (input.tool_calls || []).length; index += 1) {
        const tool = input.tool_calls[index];
        await client.query(
          `INSERT INTO agent_tool_executions
            (execution_id, decision_id, sequence, tool_name, capability, risk_level,
             policy_result, status, attempt, input_summary, result_summary,
             error_code, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)`,
          [randomUUID(), decisionId, index + 1, tool.tool, tool.capability || null,
            tool.risk || null, tool.policy || 'DENY', tool.status, tool.attempt || 1,
            JSON.stringify(tool.input || {}), JSON.stringify(tool.result || {}),
            tool.error_code || null, tool.duration_ms || null]
        );
      }
      return { decision_id: decisionId, ...input };
    });
  }
}

export class InMemoryConversationAgentRepository {
  constructor() {
    this.decisions = new Map();
    this.leases = new Map();
    this.handoffs = new Map();
  }

  async findDecision(key) { return this.decisions.get(key) || null; }

  async recentDecisions(conversationId, customerId) {
    return [...this.decisions.values()].filter(row => row.conversation_id === conversationId &&
      (row.customer_id || null) === (customerId || null) && row.created_at > Date.now() - 86_400_000).reverse().slice(0,5);
  }

  async activeHandoff(conversationId, customerId) {
    return [...this.handoffs.values()].find(row => row.conversation_id === conversationId &&
      (!row.customer_id || row.customer_id === (customerId || null)) && ['REQUESTED','ASSIGNED'].includes(row.status)) || null;
  }

  async claimTurn({ conversationKey, messageId, leaseMs = 30_000 }) {
    const now = Date.now();
    const current = this.leases.get(conversationKey);
    if (current && current.until > now) return { acquired: false };
    const token = randomUUID();
    this.leases.set(conversationKey, { token, messageId, until: now + leaseMs });
    return { acquired: true, token, claim_until: new Date(now + leaseMs).toISOString() };
  }

  async releaseTurn(conversationKey, token) {
    const current = this.leases.get(conversationKey);
    if (!current || current.token !== token) return false;
    this.leases.delete(conversationKey);
    return true;
  }

  async requestHandoff(input) {
    const active = await this.activeHandoff(input.conversation_id,input.customer_id);
    if (active) return {...active,duplicate:true};
    const existing = this.handoffs.get(input.idempotency_key);
    if (existing) return { ...existing, duplicate: true };
    const handoff = { handoff_id: randomUUID(), status: 'REQUESTED', duplicate: false, ...input };
    this.handoffs.set(input.idempotency_key, handoff);
    return handoff;
  }

  async recordDecision(input) {
    const existing = this.decisions.get(input.idempotency_key);
    if (existing) return existing;
    const decision = { decision_id: randomUUID(), created_at:Date.now(), ...input };
    this.decisions.set(input.idempotency_key, decision);
    return decision;
  }
}
