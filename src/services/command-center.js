import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AUTONOMY_DEFINITIONS,
  exceptionPriority,
  supportError,
} from '../core/support.js';
import { pageOptions } from './support-repository.js';
import { CAPABILITIES } from '../authorization.js';

const HUMAN = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'];
const ratio = (n, d) => ({
  numerator: Number(n),
  denominator: Number(d),
  value: Number(d) ? Number(n) / Number(d) : null,
});
const avg = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const ms = (a, b) =>
  a && b ? Math.max(0, Date.parse(a) - Date.parse(b)) : null;
export function supportMetrics(cases) {
  const eligible = cases.filter((c) => c.automation_eligible);
  return {
    definitions: AUTONOMY_DEFINITIONS,
    eligible_requests: eligible.length,
    total_requests: cases.length,
    autonomous_resolution_rate: ratio(
      eligible.filter(
        (c) =>
          ['RESOLVED', 'CLOSED'].includes(c.status) &&
          !c.human_intervention &&
          c.verification_result === 'VERIFIED',
      ).length,
      eligible.length,
    ),
    human_handoff_rate: ratio(
      cases.filter((c) => c.human_intervention).length,
      cases.length,
    ),
    exception_rate: ratio(
      cases.filter((c) => c.exception_id).length,
      cases.length,
    ),
    repeat_contact_rate: ratio(
      cases.filter((c) => c.previous_case_id).length,
      cases.length,
    ),
    first_response_time: avg(
      cases
        .map((c) => ms(c.first_response_at, c.created_at))
        .filter((v) => v !== null),
    ),
    time_to_resolution: avg(
      cases
        .map((c) => ms(c.resolved_at, c.created_at))
        .filter((v) => v !== null),
    ),
  };
}
const listItem = (row) => ({
  id: row.id,
  customer_id: row.customer_id,
  customer_name:
    row.context?.identity?.name?.value || row.customer_name || row.customer_id,
  conversation_id: row.conversation_id,
  support_case_id: row.support_case_id || row.id,
  exception_id: row.exception_id,
  category: row.category,
  severity: row.severity,
  status: row.status,
  summary: row.summary,
  reason_code: row.reason_code,
  recommended_action: row.recommended_action,
  created_at: row.created_at,
  updated_at: row.updated_at,
  priority: row.priority,
  intent: row.intent,
  agent: 'SupportAgent',
  last_action: row.attempts?.at(-1)?.action || row.diagnosis,
  handoff: row.human_intervention || false,
  correlation_id: row.correlation_id,
});
function filtered(rows, q, kind) {
  return rows.filter(
    (r) =>
      (!q.customer_id || r.customer_id === q.customer_id) &&
      (!q.status || r.status === q.status) &&
      (!q.severity || r.severity === q.severity) &&
      (!q.category || r.category === q.category) &&
      (q.human_required !== 'true' ||
        (kind === 'exceptions'
          ? HUMAN.includes(r.status)
          : r.status === 'HUMAN_REQUIRED')) &&
      (!q.age ||
        Date.now() - Date.parse(r.created_at) >= Number(q.age) * 60000),
  );
}
export class MemoryCommandCenter {
  constructor({ repository, context, decisions = null }) {
    this.repository = repository;
    this.context = context;
    this.decisions = decisions;
  }
  async summary() {
    const cases = [...this.repository.tables.cases.values()];
    const exceptions = [...this.repository.tables.exceptions.values()];
    return {
      mode: 'LOCAL_FAKE_ONLY',
      active_customers: new Set(cases.map((c) => c.customer_id)).size,
      revenue_cents: null,
      mrr_cents: null,
      renewals: null,
      pending_payments: null,
      leads: null,
      active_conversations: new Set(
        cases
          .filter((c) => !['RESOLVED', 'CLOSED'].includes(c.status))
          .map((c) => c.conversation_id),
      ).size,
      support_cases: cases.length,
      automatically_resolved: cases.filter(
        (c) => c.status === 'RESOLVED' && !c.human_intervention,
      ).length,
      human_required: exceptions.filter((e) => HUMAN.includes(e.status)).length,
      automation_failures: cases.filter(
        (c) => c.automation_eligible && c.human_intervention,
      ).length,
      incident_candidates: this.repository.tables.incidents.size,
    };
  }
  async metrics() {
    const calls = [...(this.decisions?.decisions.values() || [])].flatMap(
      (d) => d.tool_calls || [],
    );
    return {
      ...supportMetrics([...this.repository.tables.cases.values()]),
      tool_success_rate: ratio(
        calls.filter((c) => c.status === 'SUCCESS').length,
        calls.length,
      ),
      autonomous_renewal_rate: ratio(0, 0),
    };
  }
  async list(kind, q = {}) {
    const { limit, offset } = pageOptions(q);
    let source = [
      ...this.repository.tables[
        kind === 'conversations' ? 'cases' : kind
      ].values(),
    ];
    if (kind === 'conversations')
      source = [
        ...new Map(
          source
            .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
            .map((r) => [`${r.customer_id}:${r.conversation_id}`, r]),
        ).values(),
      ];
    const rows = filtered(source, q, kind);
    if (kind === 'exceptions')
      rows.sort(
        (a, b) =>
          exceptionPriority(b) - exceptionPriority(a) ||
          a.created_at.localeCompare(b.created_at),
      );
    else rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      items: rows.slice(offset, offset + limit).map(listItem),
      limit,
      offset,
      has_more: rows.length > offset + limit,
    };
  }
  async detail(customer, id) {
    return this.repository.get('exceptions', id, customer);
  }
  async activity(q = {}) {
    const { limit, offset } = pageOptions(q);
    const rows = this.repository.audits
      .filter(
        (a) =>
          a.resource.type !== 'notification' &&
          (!q.customer_id || a.after.customer_id === q.customer_id),
      )
      .reverse();
    return {
      items: rows
        .slice(offset, offset + limit)
        .map((a) => ({
          timestamp: a.timestamp,
          actor: a.actor.id,
          customer: a.after.customer_id,
          action: a.action,
          result: a.after.status,
          correlation_id: a.correlation_id,
        })),
      limit,
      offset,
      has_more: rows.length > offset + limit,
    };
  }
  async customer(customer) {
    return {
      customer360: await this.context(customer),
      activity: await this.activity({ customer_id: customer }),
    };
  }
}

export class PgCommandCenter {
  constructor({ db, repository, loadCustomer }) {
    this.db = db;
    this.repository = repository;
    this.loadCustomer = loadCustomer;
  }
  async summary() {
    const { rows } = await this.db.query(`SELECT
      (SELECT count(*) FROM customers WHERE status='active') AS active_customers,
      (SELECT sum(amount_cents) FROM payments WHERE status='CONFIRMED' AND confirmed_at>=date_trunc('month',now())) AS revenue_cents,
      (SELECT count(*) FROM renewal_jobs WHERE upper(status) NOT IN ('COMPLETED','CANCELLED')) AS renewals,
      (SELECT count(*) FROM payments WHERE status IN ('CREATED','PENDING')) AS pending_payments,
      (SELECT count(*) FROM leads) AS leads,
      (SELECT count(*) FROM conversation_sessions WHERE last_activity_at>now()-interval '24 hours') AS active_conversations,
      (SELECT count(*) FROM customer_issues WHERE support_data IS NOT NULL) AS support_cases,
      (SELECT count(*) FROM customer_issues WHERE support_data->>'status'='RESOLVED' AND support_data->>'human_intervention'='false') AS automatically_resolved,
      (SELECT count(*) FROM support_exceptions WHERE data->>'status' IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS')) AS human_required,
      (SELECT count(*) FROM customer_issues WHERE support_data->>'automation_eligible'='true' AND support_data->>'human_intervention'='true') AS automation_failures,
      (SELECT count(*) FROM support_incident_candidates) AS incident_candidates`);
    return {
      ...Object.fromEntries(
        Object.entries(rows[0]).map(([k, v]) => [
          k,
          v === null ? null : Number(v),
        ]),
      ),
      mrr_cents: null,
      mode: 'LOCAL_FAKE_ONLY',
    };
  }
  async metrics() {
    const [
      {
        rows: [s],
      },
      {
        rows: [t],
      },
      {
        rows: [r],
      },
    ] = await Promise.all([
      this.db
        .query(`SELECT count(*) AS total, count(*) FILTER(WHERE support_data->>'automation_eligible'='true') AS eligible,
        count(*) FILTER(WHERE support_data->>'automation_eligible'='true' AND support_data->>'status' IN ('RESOLVED','CLOSED') AND support_data->>'human_intervention'='false' AND support_data->>'verification_result'='VERIFIED') AS resolved,
        count(*) FILTER(WHERE support_data->>'human_intervention'='true') AS handoff,
        count(*) FILTER(WHERE support_data->>'exception_id' IS NOT NULL) AS exceptions,
        count(*) FILTER(WHERE support_data->>'previous_case_id' IS NOT NULL) AS repeat,
        avg(extract(epoch FROM ((support_data->>'first_response_at')::timestamptz-created_at))*1000) AS first_response,
        avg(extract(epoch FROM (resolved_at-created_at))*1000) AS resolution
        FROM customer_issues WHERE support_data IS NOT NULL`),
      this.db.query(
        "SELECT count(*) AS total,count(*) FILTER(WHERE status='SUCCESS') AS success FROM agent_tool_executions",
      ),
      this.db.query(
        `SELECT count(*) AS eligible,count(*) FILTER(WHERE autonomous AND outcome='RESOLVED' AND response_facts->>'renewal_status'='COMPLETED') AS resolved FROM agent_decisions WHERE eligible_for_automation AND intents @> '[{"name":"RENEWAL_REQUEST"}]'::jsonb`,
      ),
    ]);
    return {
      definitions: AUTONOMY_DEFINITIONS,
      eligible_requests: Number(s.eligible),
      total_requests: Number(s.total),
      autonomous_resolution_rate: ratio(s.resolved, s.eligible),
      human_handoff_rate: ratio(s.handoff, s.total),
      exception_rate: ratio(s.exceptions, s.total),
      repeat_contact_rate: ratio(s.repeat, s.total),
      first_response_time:
        s.first_response === null ? null : Number(s.first_response),
      time_to_resolution: s.resolution === null ? null : Number(s.resolution),
      tool_success_rate: ratio(t.success, t.total),
      autonomous_renewal_rate: ratio(r.resolved, r.eligible),
    };
  }
  async list(kind, q = {}) {
    const { limit, offset } = pageOptions(q);
    const isException = kind === 'exceptions';
    const table = isException ? 'support_exceptions' : 'customer_issues';
    const d = isException ? 'data' : 'support_data';
    const values = [];
    const where = [`${d} IS NOT NULL`];
    for (const key of ['customer_id', 'status', 'severity', 'category'])
      if (q[key]) {
        values.push(q[key]);
        where.push(
          key === 'customer_id'
            ? `customer_id=$${values.length}`
            : `${d}->>'${key}'=$${values.length}`,
        );
      }
    if (q.human_required === 'true')
      where.push(
        isException
          ? `${d}->>'status' IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS')`
          : `${d}->>'status'='HUMAN_REQUIRED'`,
      );
    if (q.age) {
      values.push(q.age);
      where.push(
        `(${d}->>'created_at')::timestamptz<=now()-($${values.length}::text||' minutes')::interval`,
      );
    }
    values.push(limit + 1, offset);
    const order = isException
      ? `LEAST(100, COALESCE((${d}->>'priority')::int,0)+LEAST(15,GREATEST(0,floor(extract(epoch FROM(now()-(${d}->>'created_at')::timestamptz))/3600)))) DESC, updated_at`
      : 'updated_at DESC';
    const source =
      kind === 'conversations'
        ? `(SELECT DISTINCT ON (customer_id,support_data->>'conversation_id') * FROM customer_issues WHERE support_data IS NOT NULL ORDER BY customer_id,support_data->>'conversation_id',updated_at DESC,id DESC) AS latest`
        : table;
    const result = await this.db.query(
      `SELECT ${d} AS data FROM ${source} WHERE ${where.join(' AND ')} ORDER BY ${order},id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      items: result.rows.slice(0, limit).map((r) => listItem(r.data)),
      limit,
      offset,
      has_more: result.rows.length > limit,
    };
  }
  async detail(customer, id) {
    return this.repository.get('exceptions', id, customer);
  }
  async activity(q = {}) {
    const { limit, offset } = pageOptions(q);
    const params = [limit + 1, offset];
    if (q.customer_id) params.push(q.customer_id);
    const result = await this.db.query(
      `SELECT created_at AS timestamp,actor_id AS actor,after_data->>'customer_id' AS customer,action,after_data->>'status' AS result,after_data->>'correlation_id' AS correlation_id FROM audit_logs WHERE (action LIKE 'support.%' OR action LIKE 'exception.%' OR action LIKE 'renewal.%' OR action LIKE 'customer.%') ${q.customer_id ? "AND after_data->>'customer_id'=$3" : ''} ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`,
      params,
    );
    return {
      items: result.rows.slice(0, limit),
      limit,
      offset,
      has_more: result.rows.length > limit,
    };
  }
  async customer(customer) {
    return {
      customer360: await this.loadCustomer(customer),
      activity: await this.activity({ customer_id: customer }),
    };
  }
}

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(100000).optional(),
    customer_id: z.uuid().optional(),
    status: z.string().max(30).optional(),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    category: z.string().max(40).optional(),
    human_required: z.enum(['true', 'false']).optional(),
    age: z.coerce.number().int().min(0).max(525600).optional(),
  })
  .strict();
export function registerCommandCenter(app, { readModel, operations, protect }) {
  const wrap = (fn) => async (req, reply) => {
    try {
      return await fn(req);
    } catch (error) {
      const status =
        error instanceof z.ZodError
          ? 400
          : error.code === 'RESOURCE_NOT_FOUND'
            ? 404
            : 409;
      return reply
        .code(status)
        .send({
          code: error.code || 'COMMAND_CENTER_UNAVAILABLE',
          error: 'Não foi possível concluir esta seção. Tente novamente.',
        });
    }
  };
  app.get(
    '/api/admin/command-center/summary',
    { preHandler: protect(CAPABILITIES.COMMAND_CENTER_READ) },
    wrap(() => readModel.summary()),
  );
  app.get(
    '/api/admin/command-center/metrics',
    { preHandler: protect(CAPABILITIES.COMMAND_CENTER_READ) },
    wrap(() => readModel.metrics()),
  );
  app.get(
    '/api/admin/command-center/activity',
    { preHandler: protect(CAPABILITIES.COMMAND_CENTER_READ) },
    wrap((req) => readModel.activity(querySchema.parse(req.query))),
  );
  for (const [kind, capability] of [
    ['cases', CAPABILITIES.SUPPORT_READ],
    ['exceptions', CAPABILITIES.EXCEPTIONS_READ],
    ['conversations', CAPABILITIES.SUPPORT_READ],
  ]) {
    app.get(
      `/api/admin/command-center/${kind}`,
      { preHandler: protect(capability) },
      wrap((req) => readModel.list(kind, querySchema.parse(req.query))),
    );
  }
  app.get(
    '/api/admin/command-center/customers/:customer_id',
    { preHandler: protect(CAPABILITIES.CUSTOMER_READ) },
    wrap((req) => readModel.customer(z.uuid().parse(req.params.customer_id))),
  );
  app.get(
    '/api/admin/command-center/customers/:customer_id/exceptions/:exception_id',
    { preHandler: protect(CAPABILITIES.EXCEPTIONS_READ) },
    wrap((req) =>
      readModel.detail(
        z.uuid().parse(req.params.customer_id),
        z.uuid().parse(req.params.exception_id),
      ),
    ),
  );
  for (const action of ['claim', 'wait', 'resolve', 'dismiss'])
    app.post(
      `/api/admin/command-center/customers/:customer_id/exceptions/:exception_id/${action}`,
      {
        preHandler: protect(CAPABILITIES.EXCEPTIONS_MANAGE, {
          mutation: true,
          stepUp: ['resolve', 'dismiss'].includes(action),
        }),
      },
      wrap((req) => {
        const body = z
          .object({
            note: z.string().max(2000).optional(),
            result: z.literal('VERIFIED').optional(),
          })
          .strict()
          .parse(req.body || {});
        return operations.humanAction({
          ...body,
          customer_id: z.uuid().parse(req.params.customer_id),
          exception_id: z.uuid().parse(req.params.exception_id),
          action,
          actor: { type: 'ADMIN', id: req.user.id },
          correlation_id: randomUUID(),
        });
      }),
    );
}
