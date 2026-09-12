import { randomUUID } from 'node:crypto';
import {
  contextSnapshotSchema,
  customer360Schema
} from '../core/contracts.js';
import {
  contextStatus,
  customerContextError,
  freshnessFor,
  provenance,
  selectContextScopes
} from '../core/customer-context.js';
import {
  decideMemoryConflict,
  normalizeMemoryInput,
  selectRelevantMemories
} from '../core/memory.js';
import { lifecycleFromLegacyStatus } from '../core/lifecycle.js';

function toIso(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function upper(value) {
  return value ? String(value).toUpperCase() : null;
}

function sanitizeContextContent(value) {
  return String(value || '')
    .replace(/\b(senha|password|token|secret|chave\s+api)\s*[:=]\s*\S+/gi, '$1: [REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED]');
}

function rowRef(source, row, observedAt) {
  return {
    source,
    source_id: row?.id || row?.memory_id || row?.conversation_id || null,
    observed_at: toIso(observedAt || row?.updated_at || row?.created_at, new Date(0).toISOString())
  };
}

function bounded(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return fallback;
  return Math.min(number, maximum);
}

function sourceQueries(scopes, customerId, phone, { recentMessageLimit, memoryLimit }) {
  const queries = [];
  const add = (key, sql, params) => queries.push({ key, sql, params });
  if (scopes.includes('IDENTITY')) {
    add('identities', `SELECT id, identity_type, provider, normalized_value,
                              verified_at, created_at, updated_at
                         FROM customer_identities
                        WHERE customer_id = $1
                        ORDER BY verified_at DESC NULLS LAST, created_at DESC`, [customerId]);
  }
  if (scopes.includes('SUBSCRIPTION') || scopes.includes('PAYMENT') || scopes.includes('RENEWAL')) {
    add('subscription', `SELECT s.id, s.status, s.starts_on, s.expires_on, s.provider,
                                s.provider_reference, s.renewal_policy, s.created_at, s.updated_at,
                                p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
                                p.price_cents
                           FROM subscriptions s
                           JOIN plans p ON p.id = s.plan_id
                          WHERE s.customer_id = $1
                          ORDER BY s.created_at DESC LIMIT 1`, [customerId]);
  }
  if (scopes.includes('PAYMENT') || scopes.includes('PENDING_ACTIONS')) {
    add('payments', `SELECT id, subscription_id, charge_id, provider, amount_cents, currency,
                            status, correlation_id, confirmed_at, created_at, updated_at
                      FROM payments
                     WHERE customer_id = $1
                        AND subscription_id = (
                          SELECT id FROM subscriptions
                           WHERE customer_id = $1
                           ORDER BY created_at DESC LIMIT 1
                        )
                      ORDER BY created_at DESC LIMIT 5`, [customerId]);
    add('charges', `SELECT ch.id, ch.subscription_id, ch.status, ch.amount_cents,
                           ch.due_on, ch.paid_at, ch.created_at, ch.updated_at
                     FROM charges ch
                      JOIN subscriptions s ON s.id = ch.subscription_id
                     WHERE s.customer_id = $1
                       AND ch.subscription_id = (
                         SELECT id FROM subscriptions
                          WHERE customer_id = $1
                          ORDER BY created_at DESC LIMIT 1
                       )
                     ORDER BY ch.created_at DESC LIMIT 5`, [customerId]);
  }
  if (scopes.includes('RENEWAL') || scopes.includes('PENDING_ACTIONS')) {
    add('renewals', `SELECT r.id, ch.subscription_id, r.payment_id,
                            COALESCE(rs.state, r.core_status) AS core_status,
                            rs.state AS saga_state, rs.target_expiration,
                            rs.failure_class,
                            r.status AS legacy_status, r.previous_expiration,
                            r.requested_extension_months, r.completed_at,
                            r.failure_reason, r.correlation_id, r.created_at, r.updated_at
                       FROM renewal_jobs r
                       JOIN charges ch ON ch.id = r.charge_id
                      JOIN subscriptions s ON s.id = ch.subscription_id
                       LEFT JOIN renewal_sagas rs ON rs.renewal_id = r.id
                      WHERE s.customer_id = $1
                        AND ch.subscription_id = (
                          SELECT id FROM subscriptions
                           WHERE customer_id = $1
                           ORDER BY created_at DESC LIMIT 1
                        )
                      ORDER BY r.created_at DESC LIMIT 5`, [customerId]);
  }
  if (scopes.includes('CONVERSATION') || scopes.includes('PENDING_ACTIONS')) {
    add('conversation', `SELECT conversation_id, customer_id, channel, state, context_state,
                                data, started_at, last_activity_at, summary, handoff_status,
                                correlation_id, pending_actions, revision, updated_at
                           FROM conversation_sessions
                          WHERE customer_id = $1
                             OR (customer_id IS NULL AND whatsapp_e164 = $2)
                          ORDER BY last_activity_at DESC NULLS LAST, updated_at DESC LIMIT 1`, [customerId, phone]);
  }
  if (scopes.includes('CONVERSATION')) {
    add('messages', `SELECT id, conversation_id, direction, content_type, content,
                            provider_id, status, processing_status, correlation_id, created_at
                       FROM message_logs
                      WHERE customer_id = $1
                      ORDER BY created_at DESC LIMIT $2`, [customerId, recentMessageLimit]);
  }
  if (scopes.includes('SUPPORT') || scopes.includes('PENDING_ACTIONS')) {
    add('support', `SELECT id, category, summary, status, occurrences, correlation_id,
                           first_reported_at, last_mentioned_at, resolved_at, updated_at
                      FROM customer_issues
                     WHERE customer_id = $1
                     ORDER BY last_mentioned_at DESC LIMIT 5`, [customerId]);
  }
  if (scopes.includes('MEMORY')) {
    add('memories', `SELECT memory_id, customer_id, memory_type, memory_key, value, source,
                            source_reference, confidence, observed_at, valid_from, valid_until,
                            superseded_by, status, created_at
                       FROM customer_memories
                      WHERE customer_id = $1
                        AND status IN ('ACTIVE', 'DISPUTED')
                      ORDER BY observed_at DESC LIMIT $2`, [customerId, Math.max(memoryLimit * 3, memoryLimit)]);
  }
  if (scopes.includes('PENDING_ACTIONS')) {
    add('provisioning', `SELECT id, subscription_id, renewal_id, provider, operation,
                                COALESCE(orchestration_state, status) AS status,
                                correlation_id, created_at, updated_at
                           FROM provisioning_operations
                          WHERE customer_id = $1
                            AND status IN ('REQUESTED', 'PROCESSING', 'HUMAN_ACTION_REQUIRED')
                          ORDER BY created_at DESC LIMIT 10`, [customerId]);
  }
  return queries;
}

async function loadSources(db, queries) {
  const entries = await Promise.all(queries.map(async ({ key, sql, params }) => {
    const result = await db.query(sql, params);
    return [key, result.rows];
  }));
  return Object.fromEntries(entries);
}

function minimizedIdentities(customer, identities, { channel, now }) {
  const whatsappChannel = String(channel).toUpperCase() === 'WHATSAPP';
  const allowed = whatsappChannel ? new Set(['WHATSAPP', 'PHONE']) : null;
  const selected = identities
    .filter((identity) => !allowed || allowed.has(identity.identity_type))
    .map((identity) => ({
      type: identity.identity_type,
      provider: identity.provider,
      value: provenance(identity.normalized_value, {
        source: 'customer_identities',
        sourceId: identity.id,
        observedAt: identity.verified_at || identity.updated_at || identity.created_at,
        domain: 'identity',
        now
      })
    }));
  if (
    customer.whatsapp_e164 &&
    !selected.some((identity) => ['WHATSAPP', 'PHONE'].includes(identity.type))
  ) {
    selected.push({
      type: 'WHATSAPP',
      provider: 'legacy-core',
      value: provenance(customer.whatsapp_e164, {
        source: 'customers',
        sourceId: customer.id,
        observedAt: customer.updated_at,
        domain: 'identity',
        now
      })
    });
  }
  return selected;
}

function buildPendingActions({ payments, charges, renewals, provisioning, conversation, support }) {
  const actions = [];
  const latestPayment = payments[0] || null;
  const pendingPayment = ['CREATED', 'PENDING'].includes(upper(latestPayment?.status))
    ? latestPayment
    : null;
  if (pendingPayment) {
    actions.push({
      type: 'PAYMENT',
      status: pendingPayment.status,
      reference_id: pendingPayment.id,
      correlation_id: pendingPayment.correlation_id || null
    });
  } else {
    const latestCharge = charges[0] || null;
    const pendingCharge = latestCharge && !['PAID', 'CANCELLED', 'EXPIRED', 'REJECTED']
      .includes(upper(latestCharge.status))
      ? latestCharge
      : null;
    if (pendingCharge) {
      actions.push({ type: 'CHARGE', status: upper(pendingCharge.status), reference_id: pendingCharge.id });
    }
  }
  const latestRenewal = renewals[0] || null;
  const latestRenewalStatus = upper(latestRenewal?.core_status || latestRenewal?.legacy_status);
  const pendingRenewal = latestRenewal && ![
    'COMPLETED', 'FAILED', 'CANCELLED', 'SIMULATED'
  ].includes(latestRenewalStatus)
    ? latestRenewal
    : null;
  if (pendingRenewal) {
    actions.push({
      type: 'RENEWAL',
      status: pendingRenewal.core_status || upper(pendingRenewal.legacy_status),
      reference_id: pendingRenewal.id,
      correlation_id: pendingRenewal.correlation_id || null
    });
  }
  for (const operation of provisioning) {
    actions.push({
      type: 'PROVISIONING',
      status: operation.status,
      operation: operation.operation,
      reference_id: operation.id,
      correlation_id: operation.correlation_id || null
    });
  }
  const sessionActions = Array.isArray(conversation?.pending_actions)
    ? conversation.pending_actions
    : [];
  actions.push(...sessionActions.slice(0, 10));
  if (conversation?.handoff_status && conversation.handoff_status !== 'NONE') {
    actions.push({ type: 'HUMAN_HANDOFF', status: conversation.handoff_status });
  } else if (support.some((item) => upper(item.status) === 'OPEN')) {
    actions.push({ type: 'SUPPORT', status: 'OPEN', reference_id: support[0].id });
  }
  return actions;
}

export async function createCustomerContextSnapshot(db, {
  customerId,
  resolution = { status: 'MATCHED', matched_by: null },
  purpose,
  channel = 'INTERNAL',
  requestedScopes = null,
  correlationId,
  recentMessageLimit = 12,
  memoryLimit = 6,
  persist = true,
  now = new Date(),
  logger = null
}) {
  const scopeDecision = selectContextScopes({ purpose, requestedScopes });
  const recentLimit = bounded(recentMessageLimit, 12, 30);
  const selectedMemoryLimit = bounded(memoryLimit, 6, 20);
  const customerResult = await db.query(
    `SELECT id, name, whatsapp_e164, status, lifecycle_status, operational_stage,
            name_confirmed_at, created_at, updated_at
       FROM customers WHERE id = $1`,
    [customerId]
  );
  const customer = customerResult.rows[0];
  if (!customer) throw customerContextError('CUSTOMER_NOT_FOUND', 'Cliente não encontrado.');

  let loaded;
  try {
    loaded = await loadSources(db, sourceQueries(
      scopeDecision.selected,
      customer.id,
      customer.whatsapp_e164,
      { recentMessageLimit: recentLimit, memoryLimit: selectedMemoryLimit }
    ));
  } catch {
    throw customerContextError(
      'CONTEXT_UNAVAILABLE',
      'Não foi possível compor o contexto do cliente neste momento.'
    );
  }
  const identities = loaded.identities || [];
  const subscription = loaded.subscription?.[0] || null;
  const payments = loaded.payments || [];
  const charges = loaded.charges || [];
  const renewals = loaded.renewals || [];
  const conversation = loaded.conversation?.[0] || null;
  const messages = loaded.messages || [];
  const support = loaded.support || [];
  const memories = loaded.memories || [];
  const provisioning = loaded.provisioning || [];
  const missingFields = [];
  const sources = [rowRef('customers', customer, customer.updated_at)];
  const selectedRefs = [{ source: 'customers', source_id: customer.id }];
  const excludedRefs = scopeDecision.excluded.map((scope) => ({ scope }));
  const exclusionReasonCodes = [...scopeDecision.exclusionReasonCodes];
  const freshness = {
    identity: freshnessFor('identity', customer.updated_at, { now }),
    lifecycle: freshnessFor('lifecycle', customer.updated_at, { now })
  };
  const customer360 = {
    contract: 'Customer360.v1',
    customer_id: customer.id,
    resolution: {
      status: resolution.status || 'MATCHED',
      matched_by: resolution.matched_by || null
    },
    context_status: 'COMPLETE',
    selected_scopes: scopeDecision.selected,
    missing_fields: missingFields
  };

  if (scopeDecision.selected.includes('IDENTITY')) {
    customer360.identity = {
      name: customer.name_confirmed_at
        ? provenance(customer.name, {
            source: 'customers',
            sourceId: customer.id,
            observedAt: customer.name_confirmed_at,
            domain: 'identity',
            now
          })
        : null,
      identities: minimizedIdentities(customer, identities, { channel, now })
    };
    if (!customer360.identity.name) {
      missingFields.push('identity.name');
      if (customer.name && !customer.name_confirmed_at) {
        excludedRefs.push({ source: 'customers.name', source_id: customer.id });
        exclusionReasonCodes.push('UNCONFIRMED_IDENTITY');
      }
    }
    if (!customer360.identity.identities.length) missingFields.push('identity.identities');
    for (const identity of identities) {
      const minimized = String(channel).toUpperCase() === 'WHATSAPP' &&
        !['WHATSAPP', 'PHONE'].includes(identity.identity_type);
      if (minimized) {
        excludedRefs.push({ source: 'customer_identities', source_id: identity.id });
        if (!exclusionReasonCodes.includes('DATA_MINIMIZATION')) {
          exclusionReasonCodes.push('DATA_MINIMIZATION');
        }
      } else {
        sources.push(rowRef('customer_identities', identity, identity.verified_at || identity.updated_at));
        selectedRefs.push({ source: 'customer_identities', source_id: identity.id });
      }
    }
  }

  if (scopeDecision.selected.includes('LIFECYCLE')) {
    const state = customer.lifecycle_status || lifecycleFromLegacyStatus(customer.status);
    customer360.lifecycle = {
      state: provenance(state, {
        source: customer.lifecycle_status ? 'customers.lifecycle_status' : 'customers.status',
        sourceId: customer.id,
        observedAt: customer.updated_at,
        domain: 'lifecycle',
        now
      }),
      recent_transition: null
    };
  }

  if (scopeDecision.selected.includes('SUBSCRIPTION')) {
    if (!subscription) {
      customer360.subscription = null;
      missingFields.push('subscription');
      freshness.subscription = 'UNKNOWN';
    } else {
      const observedAt = subscription.updated_at || subscription.created_at;
      customer360.subscription = {
        subscription_id: subscription.id,
        plan_code: provenance(subscription.plan_code, {
          source: 'plans', sourceId: subscription.plan_id, observedAt, domain: 'subscription', now
        }),
        plan_name: provenance(subscription.plan_name, {
          source: 'plans', sourceId: subscription.plan_id, observedAt, domain: 'subscription', now
        }),
        status: provenance(upper(subscription.status), {
          source: 'subscriptions', sourceId: subscription.id, observedAt, domain: 'subscription', now
        }),
        started_at: provenance(subscription.starts_on ? String(subscription.starts_on) : null, {
          source: 'subscriptions', sourceId: subscription.id, observedAt, domain: 'subscription', now
        }),
        expires_at: provenance(subscription.expires_on ? String(subscription.expires_on) : null, {
          source: 'subscriptions', sourceId: subscription.id, observedAt, domain: 'subscription', now
        }),
        provider: provenance(subscription.provider, {
          source: 'subscriptions', sourceId: subscription.id, observedAt, domain: 'subscription', now
        }),
        ...(String(channel).toUpperCase() === 'WHATSAPP'
          ? {}
          : {
              provider_reference: provenance(subscription.provider_reference, {
                source: 'subscriptions', sourceId: subscription.id, observedAt, domain: 'subscription', now
              })
            })
      };
      freshness.subscription = freshnessFor('subscription', observedAt, { now });
      sources.push(rowRef('subscriptions', subscription, observedAt));
      selectedRefs.push({ source: 'subscriptions', source_id: subscription.id });
      if (String(channel).toUpperCase() === 'WHATSAPP' && subscription.provider_reference) {
        excludedRefs.push({
          source: 'subscriptions.provider_reference',
          source_id: subscription.id
        });
        if (!exclusionReasonCodes.includes('SENSITIVE_FIELD_MINIMIZED')) {
          exclusionReasonCodes.push('SENSITIVE_FIELD_MINIMIZED');
        }
      }
    }
  }

  if (scopeDecision.selected.includes('PAYMENT')) {
    const lastPayment = payments[0] || null;
    const latestPaymentStatus = upper(lastPayment?.status);
    const pendingPayment = ['CREATED', 'PENDING'].includes(latestPaymentStatus)
      ? lastPayment
      : null;
    const confirmedPayment = latestPaymentStatus === 'CONFIRMED' ? lastPayment : null;
    const currentCharge = charges[0] || null;
    const paymentView = (item) => item ? {
      payment_id: item.id,
      status: upper(item.status),
      amount_cents: item.amount_cents,
      currency: item.currency,
      confirmed_at: toIso(item.confirmed_at),
      observed_at: toIso(item.updated_at || item.created_at)
    } : null;
    customer360.financial = {
      current_charge: currentCharge ? {
        charge_id: currentCharge.id,
        status: upper(currentCharge.status),
        amount_cents: currentCharge.amount_cents,
        due_on: currentCharge.due_on ? String(currentCharge.due_on) : null,
        paid_at: toIso(currentCharge.paid_at),
        observed_at: toIso(currentCharge.updated_at || currentCharge.created_at)
      } : null,
      last_payment: paymentView(lastPayment),
      pending_payment: paymentView(pendingPayment),
      confirmed_payment: paymentView(confirmedPayment)
    };
    const observedAt = lastPayment?.updated_at || lastPayment?.created_at ||
      currentCharge?.updated_at || currentCharge?.created_at;
    freshness.payment = freshnessFor('payment', observedAt, { now });
    for (const item of [...payments, ...charges]) {
      const source = Object.hasOwn(item, 'currency') ? 'payments' : 'charges';
      sources.push(rowRef(source, item, item.updated_at || item.created_at));
      selectedRefs.push({ source, source_id: item.id });
    }
  }

  if (scopeDecision.selected.includes('RENEWAL')) {
    const renewal = renewals[0] || null;
    customer360.renewal = renewal ? {
      renewal_id: renewal.id,
      subscription_id: renewal.subscription_id,
      payment_id: renewal.payment_id || null,
      status: renewal.core_status || upper(renewal.legacy_status),
      previous_expiration: renewal.previous_expiration ? String(renewal.previous_expiration) : null,
      requested_extension_months: renewal.requested_extension_months || null,
      completed_at: toIso(renewal.completed_at),
      failure_reason: renewal.failure_reason || null,
      observed_at: toIso(renewal.updated_at || renewal.created_at)
    } : null;
    freshness.renewal = freshnessFor(
      'renewal',
      renewal?.updated_at || renewal?.created_at,
      { now }
    );
    for (const item of renewals) {
      const renewalSource = item.saga_state ? 'renewal_sagas' : 'renewal_jobs';
      sources.push(rowRef(renewalSource, item, item.updated_at || item.created_at));
      selectedRefs.push({ source: renewalSource, source_id: item.id });
    }
  }

  if (scopeDecision.selected.includes('CONVERSATION')) {
    customer360.conversation = conversation ? {
      conversation_id: conversation.conversation_id || null,
      channel: conversation.channel || 'whatsapp_qr',
      state: conversation.context_state || upper(conversation.state) || 'GENERAL',
      legacy_state: conversation.state || null,
      summary: conversation.summary || null,
      handoff_status: conversation.handoff_status || 'NONE',
      last_activity_at: toIso(conversation.last_activity_at || conversation.updated_at),
      correlation_id: conversation.correlation_id || null,
      recent_messages: messages.slice().reverse().map((message) => ({
        message_id: message.id,
        provider_message_id: message.provider_id || null,
        direction: upper(message.direction),
        content_type: message.content_type || 'TEXT',
        content: message.content ? sanitizeContextContent(message.content).slice(0, 1000) : null,
        processing_status: message.processing_status || message.status || null,
        correlation_id: message.correlation_id || null,
        occurred_at: toIso(message.created_at)
      }))
    } : null;
    if (!conversation) missingFields.push('conversation');
    freshness.conversation = freshnessFor(
      'conversation',
      conversation?.last_activity_at || conversation?.updated_at,
      { now }
    );
    if (conversation) {
      sources.push(rowRef('conversation_sessions', conversation, conversation.last_activity_at || conversation.updated_at));
      selectedRefs.push({ source: 'conversation_sessions', source_id: conversation.conversation_id || customer.whatsapp_e164 });
    }
    for (const message of messages) {
      sources.push(rowRef('message_logs', message, message.created_at));
      selectedRefs.push({ source: 'message_logs', source_id: message.id });
    }
  }

  if (scopeDecision.selected.includes('SUPPORT')) {
    const supportView = support.map((item) => ({
      support_case_id: item.id,
      category: item.category,
      summary: item.summary,
      status: upper(item.status),
      occurrences: item.occurrences,
      correlation_id: item.correlation_id || null,
      opened_at: toIso(item.first_reported_at),
      last_mentioned_at: toIso(item.last_mentioned_at),
      resolved_at: toIso(item.resolved_at)
    }));
    customer360.support = {
      open_cases: supportView.filter((item) => item.status !== 'RESOLVED'),
      last_case: supportView[0] || null
    };
    freshness.support = freshnessFor('support', support[0]?.last_mentioned_at, { now });
    for (const item of support) {
      sources.push(rowRef('customer_issues', item, item.last_mentioned_at));
      selectedRefs.push({ source: 'customer_issues', source_id: item.id });
    }
  }

  if (scopeDecision.selected.includes('MEMORY')) {
    customer360.memories = selectRelevantMemories(memories, {
      limit: selectedMemoryLimit,
      now
    });
    for (const item of customer360.memories) {
      sources.push(rowRef('customer_memories', item, item.observed_at));
      selectedRefs.push({ source: 'customer_memories', source_id: item.memory_id });
    }
  }

  if (scopeDecision.selected.includes('PENDING_ACTIONS')) {
    customer360.pending_actions = buildPendingActions({
      payments, charges, renewals, provisioning, conversation, support
    });
    for (const item of provisioning) {
      sources.push(rowRef('provisioning_operations', item, item.updated_at || item.created_at));
      selectedRefs.push({ source: 'provisioning_operations', source_id: item.id });
    }
  }

  customer360.context_status = contextStatus(missingFields);
  const parsedCustomer360 = customer360Schema.parse(customer360);
  const snapshot = contextSnapshotSchema.parse({
    contract: 'ContextSnapshot.v1',
    context_snapshot_id: randomUUID(),
    customer_id: customer.id,
    correlation_id: correlationId,
    purpose: scopeDecision.purpose,
    channel: String(channel || 'INTERNAL').toUpperCase(),
    created_at: new Date(now).toISOString(),
    sources,
    customer360: parsedCustomer360,
    freshness,
    selected_refs: selectedRefs,
    excluded_refs: excludedRefs,
    exclusion_reason_codes: exclusionReasonCodes
  });

  if (persist) {
    await db.query(
      `INSERT INTO customer_context_snapshots
        (context_snapshot_id, customer_id, correlation_id, purpose, channel,
         requested_scopes, selected_scopes, sources, context, freshness,
         selected_refs, excluded_refs, exclusion_reason_codes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8::jsonb,
               $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::text[], $14)`,
      [
        snapshot.context_snapshot_id,
        snapshot.customer_id,
        snapshot.correlation_id,
        snapshot.purpose,
        snapshot.channel,
        scopeDecision.requested,
        scopeDecision.selected,
        JSON.stringify(snapshot.sources),
        JSON.stringify(snapshot.customer360),
        JSON.stringify(snapshot.freshness),
        JSON.stringify(snapshot.selected_refs),
        JSON.stringify(snapshot.excluded_refs),
        snapshot.exclusion_reason_codes,
        snapshot.created_at
      ]
    );
  }

  logger?.info?.({
    customer_id: snapshot.customer_id,
    context_snapshot_id: snapshot.context_snapshot_id,
    correlation_id: snapshot.correlation_id,
    purpose: snapshot.purpose,
    result: snapshot.customer360.context_status
  }, 'Customer context resolved');
  return snapshot;
}

export async function saveCustomerMemory(db, input, { now = new Date() } = {}) {
  const incoming = normalizeMemoryInput(input, { now });
  return db.transaction(async (client) => {
    const customer = await client.query('SELECT id FROM customers WHERE id = $1', [incoming.customerId]);
    if (!customer.rows[0]) throw customerContextError('CUSTOMER_NOT_FOUND', 'Cliente não encontrado.');
    const current = await client.query(
      `SELECT * FROM customer_memories
        WHERE customer_id = $1 AND memory_type = $2 AND memory_key = $3
          AND status = 'ACTIVE'
        FOR UPDATE`,
      [incoming.customerId, incoming.type, incoming.key]
    );
    const existing = current.rows[0] || null;
    const decision = decideMemoryConflict(existing, incoming);
    if (decision.action === 'DUPLICATE') {
      return { memory: existing, decision, created: false };
    }
    if (decision.action === 'SUPERSEDE') {
      await client.query(
        `UPDATE customer_memories
            SET status = 'SUPERSEDED', superseded_by = NULL, updated_at = now()
          WHERE memory_id = $1`,
        [existing.memory_id]
      );
    }
    const inserted = await client.query(
      `INSERT INTO customer_memories
        (memory_id, customer_id, memory_type, memory_key, value, source,
         source_reference, confidence, observed_at, valid_from, valid_until, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        incoming.memoryId,
        incoming.customerId,
        incoming.type,
        incoming.key,
        JSON.stringify(incoming.value),
        incoming.source,
        incoming.sourceReference,
        incoming.confidence,
        incoming.observedAt,
        incoming.validFrom,
        incoming.validUntil,
        decision.status
      ]
    );
    if (decision.action === 'SUPERSEDE') {
      await client.query(
        `UPDATE customer_memories
            SET superseded_by = $2, updated_at = now()
          WHERE memory_id = $1`,
        [existing.memory_id, incoming.memoryId]
      );
    }
    return {
      memory: inserted.rows[0],
      decision,
      created: true,
      conflict: decision.action === 'DISPUTE'
    };
  });
}
