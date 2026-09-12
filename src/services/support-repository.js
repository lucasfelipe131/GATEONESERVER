import { randomUUID } from 'node:crypto';
import { appendOutboxEvent } from '../core/outbox.js';
import { audit } from '../audit.js';
import { supportError } from '../core/support.js';

const TABLES = Object.freeze({
  cases: 'customer_issues',
  exceptions: 'support_exceptions',
  knowledge: 'support_knowledge',
  probes: 'support_probes',
  receipts: 'support_receipts',
  incidents: 'support_incident_candidates',
});
const FILTERS = new Set([
  'customer_id',
  'status',
  'severity',
  'category',
  'problem_pattern',
  'validation_status',
  'idempotency_key',
  'dedup_key',
  'support_case_id',
  'window_key',
]);
export function pageOptions(input = {}) {
  const limit = Math.min(100, Math.max(1, Number(input.limit) || 25));
  const offset = Math.max(0, Number(input.offset) || 0);
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || offset > 100000)
    throw supportError('INVALID_PAGINATION');
  return { limit, offset };
}
function match(row, filters) {
  return Object.entries(filters).every(
    ([k, v]) => v === undefined || v === '' || row[k] === v,
  );
}
function safeFilters(filters) {
  for (const key of Object.keys(filters))
    if (!FILTERS.has(key)) throw supportError('INVALID_FILTER');
}

export class InMemorySupportRepository {
  constructor() {
    this.tables = Object.fromEntries(
      Object.keys(TABLES).map((k) => [k, new Map()]),
    );
    this.events = [];
    this.audits = [];
    this.notifications = [];
    this.queue = Promise.resolve();
  }
  async transaction(customerId, fn) {
    const previous = this.queue;
    let unlock;
    this.queue = new Promise((resolve) => {
      unlock = resolve;
    });
    await previous;
    const before = structuredClone({
      tables: this.tables,
      events: this.events,
      audits: this.audits,
      notifications: this.notifications,
    });
    try {
      return await fn(this);
    } catch (error) {
      Object.assign(this, before);
      throw error;
    } finally {
      unlock();
    }
  }
  async list(kind, filters = {}, options = {}) {
    safeFilters(filters);
    const { limit, offset } = pageOptions(options);
    const rows = [...this.tables[kind].values()]
      .filter((row) => match(row, filters))
      .sort(
        (a, b) =>
          String(b.updated_at).localeCompare(String(a.updated_at)) ||
          b.id.localeCompare(a.id),
      );
    return structuredClone(rows.slice(offset, offset + limit));
  }
  async get(kind, id, customerId) {
    const row = this.tables[kind].get(id);
    if (!row || (customerId !== undefined && row.customer_id !== customerId))
      throw supportError('RESOURCE_NOT_FOUND');
    return structuredClone(row);
  }
  async put(kind, row) {
    this.tables[kind].set(row.id, structuredClone(row));
    return row;
  }
  async emit(event, before, after) {
    this.events.push(event);
    this.audits.push({
      actor: event.actor,
      action: event.event_type,
      resource: event.subject,
      before,
      after,
      reason: after?.reason_code || event.event_type,
      timestamp: event.occurred_at,
      correlation_id: event.correlation_id,
    });
  }
  async notify(notification) {
    this.notifications.push(notification);
  }
  async updateConversation() {
    /* Future context is projected from the same cases and exceptions. */
  }
  async legacyCase() {
    return null;
  }
  async activeCase(customerId, category) {
    const row = [...this.tables.cases.values()]
      .filter(
        (c) =>
          c.customer_id === customerId &&
          c.category === category &&
          !['RESOLVED', 'CLOSED'].includes(c.status),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    return row ? structuredClone(row) : null;
  }
  async incidentCount(problem, after) {
    return new Set(
      [...this.tables.cases.values()]
        .filter((c) => c.diagnosis === problem && c.created_at >= after)
        .map((c) => c.customer_id),
    ).size;
  }
}

class PgSupportTransaction {
  constructor(client) {
    this.client = client;
  }
  async list(kind, filters = {}, options = {}) {
    if (!TABLES[kind]) throw supportError('INVALID_RESOURCE');
    safeFilters(filters);
    const { limit, offset } = pageOptions(options);
    const data = kind === 'cases' ? 'support_data' : 'data';
    const values = [];
    const conditions = [`${data} IS NOT NULL`];
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined && value !== '') {
        values.push(value);
        conditions.push(
          key === 'customer_id'
            ? `customer_id = $${values.length}`
            : `${data}->>'${key}' = $${values.length}`,
        );
      }
    values.push(limit, offset);
    const result = await this.client.query(
      `SELECT ${data} AS data FROM ${TABLES[kind]} WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return result.rows.map((r) => r.data);
  }
  async get(kind, id, customerId) {
    if (!TABLES[kind]) throw supportError('INVALID_RESOURCE');
    const data = kind === 'cases' ? 'support_data' : 'data';
    const result = await this.client.query(
      `SELECT ${data} AS data FROM ${TABLES[kind]} WHERE id = $1${customerId === undefined ? '' : ' AND customer_id = $2'}`,
      customerId === undefined ? [id] : [id, customerId],
    );
    if (!result.rows[0]?.data) throw supportError('RESOURCE_NOT_FOUND');
    return result.rows[0].data;
  }
  async put(kind, row) {
    if (kind === 'cases') {
      await this.client.query(
        `INSERT INTO customer_issues (id, customer_id, category, summary, status, correlation_id, support_data, updated_at, resolved_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT(id) DO UPDATE SET category=EXCLUDED.category, summary=EXCLUDED.summary, status=EXCLUDED.status, support_data=EXCLUDED.support_data, updated_at=EXCLUDED.updated_at, resolved_at=EXCLUDED.resolved_at, last_mentioned_at=EXCLUDED.updated_at`,
        [
          row.id,
          row.customer_id,
          row.category,
          row.summary,
          ['RESOLVED', 'CLOSED'].includes(row.status)
            ? 'resolved'
            : row.status.startsWith('WAITING')
              ? 'monitoring'
              : 'open',
          row.correlation_id,
          JSON.stringify(row),
          row.updated_at,
          row.resolved_at,
        ],
      );
    } else {
      if (!TABLES[kind]) throw supportError('INVALID_RESOURCE');
      const cols = ['id', 'data', 'updated_at'];
      const vals = [row.id, JSON.stringify(row), row.updated_at];
      if (kind !== 'incidents') {
        cols.push('customer_id');
        vals.push(row.customer_id || null);
      }
      if (kind === 'exceptions') {
        cols.push('support_case_id', 'dedup_key');
        vals.push(row.support_case_id, row.dedup_key);
      }
      await this.client.query(
        `INSERT INTO ${TABLES[kind]} (${cols.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
        vals,
      );
    }
    return row;
  }
  async emit(event, before, after) {
    await appendOutboxEvent(this.client, event);
    await audit(this.client, {
      actorType: event.actor.type,
      actorId: event.actor.id,
      action: event.event_type,
      entityType: event.subject.type,
      entityId: event.subject.id,
      before,
      after: {
        ...after,
        correlation_id: event.correlation_id,
        reason: after?.reason_code || event.event_type,
      },
    });
  }
  async notify(n) {
    await this.client.query(
      `INSERT INTO notification_requests (id,customer_id,channel,intention,context,priority,correlation_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [
        n.notification_id,
        n.customer_id,
        n.channel,
        n.intention,
        JSON.stringify(n.context),
        n.priority,
        n.correlation_id,
      ],
    );
  }
  async updateConversation(row) {
    await this.client.query(
      `UPDATE conversation_sessions SET context_state=$3, handoff_status=$4, data=data || $5::jsonb, updated_at=now() WHERE customer_id=$1 AND conversation_id=$2`,
      [
        row.customer_id,
        row.conversation_id,
        row.status === 'RESOLVED' ? 'SUPPORT' : 'HUMAN_HANDOFF',
        row.status === 'RESOLVED' ? 'RESOLVED' : 'REQUESTED',
        JSON.stringify({ support_case_id: row.id, support_status: row.status }),
      ],
    );
  }
  async legacyCase(customerId) {
    const result = await this.client.query(
      "SELECT id,created_at,summary,category FROM customer_issues WHERE customer_id=$1 AND support_data IS NULL AND status IN ('open','monitoring') ORDER BY last_mentioned_at DESC LIMIT 1 FOR UPDATE",
      [customerId],
    );
    return result.rows[0] || null;
  }
  async activeCase(customerId, category) {
    const result = await this.client.query(
      "SELECT support_data AS data FROM customer_issues WHERE customer_id=$1 AND category=$2 AND support_data->>'status' NOT IN ('RESOLVED','CLOSED') ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",
      [customerId, category],
    );
    return result.rows[0]?.data || null;
  }
  async incidentCount(problem, after) {
    const result = await this.client.query(
      "SELECT count(DISTINCT customer_id) AS count FROM customer_issues WHERE support_data->>'diagnosis'=$1 AND created_at>=$2",
      [problem, after],
    );
    return Number(result.rows[0].count);
  }
}
export class PgSupportRepository extends PgSupportTransaction {
  constructor(db) {
    super(db);
    this.db = db;
  }
  async transaction(customerId, fn) {
    return this.db.transaction(async (client) => {
      // Same lock order for all support writes; covers incident grouping and exception dedup.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('gate-support.v1'))",
      );
      return fn(new PgSupportTransaction(client));
    });
  }
}

export function localSupportEnabled(env = process.env) {
  return (
    env.SUPPORT_AGENT_ENABLED === 'true' &&
    ['test', 'local'].includes(env.GATE_ENVIRONMENT) &&
    env.PROVIDER_MODE === 'fake-only' &&
    env.NODE_ENV !== 'production'
  );
}
export function assertLocalSupport(env) {
  if (!localSupportEnabled(env)) throw supportError('SUPPORT_LOCAL_ONLY');
}
export const newSupportId = () => randomUUID();
