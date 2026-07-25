import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import rawBody from 'fastify-raw-body';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createDb, getSetting, setSetting } from './db.js';
import { initializeDatabase } from './init.js';
import { authenticate, clearSessionCookie, login, logout, setSessionCookie } from './auth.js';
import { audit } from './audit.js';
import { createQueues, createRedis } from './queue.js';
import { maskPhone, normalizePhone, randomToken, sanitizeForLog, sha256 } from './security.js';
import { scanBilling, markPaymentApproved } from './services/billing.js';
import { buildIdempotencyKey, renderChargeMessage } from './domain/billing.js';
import {
  getMercadoPagoPayment,
  getMercadoPagoReadiness,
  verifyMercadoPagoWebhook
} from './integrations/mercadopago.js';
import {
  parseWhatsAppWebhook,
  verifyMetaSignature
} from './integrations/whatsapp.js';
import { handleInboundMessage } from './services/sales.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
const redis = config.REDIS_URL ? createRedis(config.REDIS_URL) : null;
const queues = redis ? createQueues(redis) : null;
const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers.set-cookie',
      '*.password',
      '*.token',
      '*.pix_copy_paste'
    ]
  },
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024
});

await app.register(cookie, { secret: config.COOKIE_SECRET });
await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"]
    }
  }
});
await app.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true });
await app.register(fastifyStatic, {
  root: join(here, '..', 'public'),
  prefix: '/'
});

app.decorateRequest('user', null);

function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const error = new Error(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
    error.statusCode = 400;
    throw error;
  }
  return parsed.data;
}

async function requireAuth(request, reply) {
  request.user = await authenticate(db, request);
  if (!request.user) return reply.code(401).send({ error: 'Sessão expirada. Entre novamente.' });
}

function requireQueues(reply) {
  if (queues) return true;
  reply.code(503).send({ error: 'Redis ainda não está conectado.' });
  return false;
}

async function maybeQueueBitPanelJob(renewalId, approvedBy = null) {
  if (!queues || !renewalId) return { queued: false, reason: 'queue_unavailable' };
  const [paused, requiresApproval] = await Promise.all([
    getSetting(db, 'global_pause', config.GLOBAL_PAUSE),
    getSetting(db, 'renewal_requires_approval', config.RENEWAL_REQUIRES_APPROVAL)
  ]);
  if (paused) return { queued: false, reason: 'global_pause' };
  if (requiresApproval) return { queued: false, reason: 'approval_required' };

  const result = await db.query(
    `UPDATE renewal_jobs
        SET status = 'queued', approved_by = $2, approved_at = now(), error = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('awaiting_approval', 'manual_review', 'simulated')
      RETURNING id`,
    [renewalId, approvedBy]
  );
  if (!result.rows[0]) return { queued: false, reason: 'already_queued' };

  await queues.renewals.add(
    'execute-renewal',
    { renewalId: result.rows[0].id },
    {
      jobId: `renewal-auto-${result.rows[0].id}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000
    }
  );
  await audit(db, {
    actorType: 'system',
    action: 'bitpanel.job_queued_automatically',
    entityType: 'renewal_job',
    entityId: result.rows[0].id
  });
  return { queued: true };
}

app.get('/health', async (_request, reply) => {
  try {
    await db.query('SELECT 1');
    const redisStatus = redis ? await redis.ping() : 'not_configured';
    return { ok: true, database: 'ok', redis: redisStatus, service: 'web' };
  } catch (error) {
    return reply.code(503).send({ ok: false, error: error.message });
  }
});

app.post(
  '/api/auth/login',
  { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
  async (request, reply) => {
    const body = parse(
      z.object({ email: z.email(), password: z.string().min(1).max(200) }),
      request.body
    );
    const result = await login(db, body.email, body.password);
    if (!result) return reply.code(401).send({ error: 'E-mail ou senha inválidos.' });
    setSessionCookie(reply, result.token, config.NODE_ENV === 'production');
    await audit(db, {
      actorType: 'user',
      actorId: result.user.id,
      action: 'auth.login',
      entityType: 'session',
      ip: request.ip
    });
    return { user: result.user };
  }
);

app.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
  await logout(db, request);
  clearSessionCookie(reply);
  return { ok: true };
});

app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({ user: request.user }));

app.get('/api/public/plans', async () => {
  const result = await db.query(
    'SELECT code, name, duration_months, price_cents FROM plans WHERE active = true ORDER BY sort_order'
  );
  return { plans: result.rows };
});

app.post(
  '/api/public/leads',
  { config: { rateLimit: { max: 8, timeWindow: '1 hour' } } },
  async (request, reply) => {
    const body = parse(
      z.object({
        name: z.string().min(2).max(120),
        whatsapp: z.string().min(10).max(30),
        desiredPlan: z.enum(['monthly', 'quarterly']).optional(),
        campaign: z.string().max(100).optional(),
        consent: z.literal(true)
      }),
      request.body
    );
    const phone = normalizePhone(body.whatsapp);
    const result = await db.query(
      `INSERT INTO leads (name, whatsapp_e164, source, campaign, desired_plan, status)
       VALUES ($1, $2, 'landing_page', $3, $4, 'new')
       RETURNING id`,
      [body.name, phone, body.campaign || null, body.desiredPlan || null]
    );
    await audit(db, {
      actorType: 'lead',
      actorId: phone,
      action: 'lead.captured',
      entityType: 'lead',
      entityId: result.rows[0].id,
      ip: request.ip
    });
    const whatsappUrl = config.PUBLIC_WHATSAPP_NUMBER
      ? `https://wa.me/${config.PUBLIC_WHATSAPP_NUMBER}?text=${encodeURIComponent('Olá! Quero conhecer os planos do Gate One Pro.')}`
      : null;
    return reply.code(201).send({
      ok: true,
      message: 'Cadastro recebido. Abra o WhatsApp do Gate One Pro para continuar.',
      whatsappUrl
    });
  }
);

app.get('/webhooks/whatsapp', async (request, reply) => {
  const query = request.query || {};
  if (
    query['hub.mode'] === 'subscribe' &&
    query['hub.verify_token'] &&
    query['hub.verify_token'] === config.WHATSAPP_VERIFY_TOKEN
  ) {
    return reply.type('text/plain').send(query['hub.challenge']);
  }
  return reply.code(403).send('Token inválido');
});

app.post(
  '/webhooks/whatsapp',
  { config: { rawBody: true }, bodyLimit: 1024 * 1024 },
  async (request, reply) => {
    const whatsappMode = await getSetting(db, 'whatsapp_mode', config.WHATSAPP_MODE);
    const runtimeConfig = { ...config, WHATSAPP_MODE: whatsappMode };
    if (
      !verifyMetaSignature(
        runtimeConfig,
        request.rawBody || Buffer.from(JSON.stringify(request.body)),
        request.headers['x-hub-signature-256']
      )
    ) {
      return reply.code(401).send({ error: 'Assinatura inválida.' });
    }
    if (!queues) return reply.code(503).send({ error: 'Redis indisponível.' });
    const messages = parseWhatsAppWebhook(request.body);
    for (const inbound of messages) {
      try {
        await handleInboundMessage({ db, queues, config, inbound });
      } catch (error) {
        app.log.error({ messageId: inbound.id, error: error.message }, 'Falha no atendimento');
      }
    }
    return { received: true };
  }
);

app.post('/webhooks/mercadopago', async (request, reply) => {
  const paymentMode = await getSetting(db, 'payment_mode', config.PAYMENT_MODE);
  const runtimeConfig = { ...config, PAYMENT_MODE: paymentMode };
  const dataId = request.query?.['data.id'] || request.body?.data?.id;
  const valid = verifyMercadoPagoWebhook({
    config: runtimeConfig,
    signature: request.headers['x-signature'],
    requestId: request.headers['x-request-id'],
    dataId
  });
  if (!valid) return reply.code(401).send({ error: 'Assinatura inválida.' });
  const eventId = String(
    request.body?.id ||
      `${request.body?.type || 'payment'}:${request.body?.action || 'update'}:${dataId || 'unknown'}:${request.body?.date_created || Date.now()}`
  );
  const inserted = await db.query(
    `INSERT INTO webhook_events (provider, provider_event_id, event_type, payload)
     VALUES ('mercadopago', $1, $2, $3::jsonb)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id`,
    [eventId, request.body?.type || null, JSON.stringify(request.body || {})]
  );
  if (!inserted.rowCount) return { received: true, duplicate: true };

  try {
    if (dataId && runtimeConfig.PAYMENT_MODE === 'live') {
      const payment = await getMercadoPagoPayment(runtimeConfig, dataId);
      if (payment.status === 'approved' && payment.external_reference) {
        const marked = await markPaymentApproved(db, payment.external_reference, payment);
        if (!marked.duplicate && queues) {
          await queues.messages.add(
            'send-payment-confirmation',
            { chargeId: payment.external_reference },
            { jobId: `paid-${payment.external_reference}` }
          );
        }
        await maybeQueueBitPanelJob(marked.renewalId);
      }
    }
    await db.query('UPDATE webhook_events SET processed_at = now() WHERE id = $1', [
      inserted.rows[0].id
    ]);
  } catch (error) {
    await db.query('UPDATE webhook_events SET error = $2 WHERE id = $1', [
      inserted.rows[0].id,
      error.message
    ]);
    app.log.error({ eventId, error: error.message }, 'Falha no webhook do Mercado Pago');
  }
  return { received: true };
});

app.get('/api/admin/summary', { preHandler: requireAuth }, async () => {
  const [customers, charges, renewals, leads, revenue, settings] = await Promise.all([
    db.query("SELECT count(*)::int AS total FROM customers WHERE status <> 'cancelled'"),
    db.query(
      `SELECT
         count(*) FILTER (WHERE status = 'awaiting_approval')::int AS awaiting,
         count(*) FILTER (WHERE status = 'sent')::int AS sent,
         count(*) FILTER (WHERE status = 'paid')::int AS paid
       FROM charges`
    ),
    db.query(
      "SELECT count(*)::int AS awaiting FROM renewal_jobs WHERE status IN ('awaiting_approval', 'manual_review')"
    ),
    db.query("SELECT count(*)::int AS total FROM leads WHERE status IN ('new', 'engaged', 'payment_pending')"),
    db.query(
      `SELECT COALESCE(sum(amount_cents), 0)::int AS cents
         FROM charges
        WHERE status = 'paid' AND paid_at >= date_trunc('month', now())`
    ),
    Promise.all([
      getSetting(db, 'global_pause', config.GLOBAL_PAUSE),
      getSetting(db, 'payment_mode', config.PAYMENT_MODE),
      getSetting(db, 'whatsapp_mode', config.WHATSAPP_MODE),
      getSetting(db, 'bitpanel_mode', config.BITPANEL_MODE)
    ])
  ]);
  return {
    customers: customers.rows[0].total,
    charges: charges.rows[0],
    renewals: renewals.rows[0].awaiting,
    leads: leads.rows[0].total,
    revenueCents: revenue.rows[0].cents,
    settings: {
      globalPause: settings[0],
      paymentMode: settings[1],
      whatsappMode: settings[2],
      bitpanelMode: settings[3]
    }
  };
});

app.get('/api/admin/plans', { preHandler: requireAuth }, async () => {
  const result = await db.query('SELECT * FROM plans ORDER BY sort_order');
  return { plans: result.rows };
});

app.get('/api/admin/customers', { preHandler: requireAuth }, async (request) => {
  const search = String(request.query?.search || '').trim();
  const result = await db.query(
    `SELECT c.id, c.name, c.whatsapp_e164, c.status, c.consent_contact, c.source,
            c.bitpanel_reference, c.created_at,
            s.id AS subscription_id, s.expires_on::text, s.bitpanel_list_id,
            p.code AS plan_code, p.name AS plan_name, p.price_cents
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT * FROM subscriptions
          WHERE customer_id = c.id AND status <> 'cancelled'
          ORDER BY created_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE ($1 = '' OR COALESCE(c.name, '') ILIKE '%' || $1 || '%'
         OR COALESCE(c.whatsapp_e164, '') LIKE '%' || $1 || '%'
         OR COALESCE(c.bitpanel_reference, '') ILIKE '%' || $1 || '%'
         OR COALESCE(s.bitpanel_list_id, '') LIKE '%' || $1 || '%')
      ORDER BY COALESCE(s.expires_on, CURRENT_DATE + 9999), c.name
      LIMIT 300`,
    [search]
  );
  return {
    customers: result.rows.map((row) => ({ ...row, whatsapp_masked: maskPhone(row.whatsapp_e164) }))
  };
});

app.post('/api/admin/customers/import-bitpanel', { preHandler: requireAuth }, async (request) => {
  const body = parse(
    z.object({
      customers: z.array(z.object({
        bitpanelListId: z.string().min(1).max(100),
        bitpanelReference: z.string().min(1).max(120),
        expiresOn: z.iso.date(),
        status: z.enum(['active', 'late', 'suspended', 'cancelled']).default('active'),
        owner: z.string().max(120).optional()
      })).min(1).max(2000)
    }),
    request.body
  );

  const stats = { imported: 0, updated: 0, errors: [] };
  for (const [index, item] of body.customers.entries()) {
    try {
      await db.transaction(async (client) => {
        const existing = await client.query(
          `SELECT c.id AS customer_id, s.id AS subscription_id
             FROM subscriptions s
             JOIN customers c ON c.id = s.customer_id
            WHERE s.bitpanel_list_id = $1
            ORDER BY s.created_at DESC LIMIT 1`,
          [item.bitpanelListId]
        );
        const plan = await client.query("SELECT id FROM plans WHERE code = 'monthly'");
        if (!plan.rows[0]) throw new Error('Plano mensal não encontrado.');

        if (existing.rows[0]) {
          await client.query(
            `UPDATE customers
                SET bitpanel_reference = $2, source = 'bitpanel',
                    status = $3, updated_at = now()
              WHERE id = $1`,
            [existing.rows[0].customer_id, item.bitpanelReference, item.status]
          );
          await client.query(
            `UPDATE subscriptions
                SET expires_on = $2, status = $3, updated_at = now()
              WHERE id = $1`,
            [existing.rows[0].subscription_id, item.expiresOn, item.status]
          );
          stats.updated += 1;
          return;
        }

        const customer = await client.query(
          `INSERT INTO customers
            (name, whatsapp_e164, bitpanel_reference, source, status, consent_contact)
           VALUES (NULL, NULL, $1, 'bitpanel', $2, false)
           RETURNING id`,
          [item.bitpanelReference, item.status]
        );
        await client.query(
          `INSERT INTO subscriptions
            (customer_id, plan_id, starts_on, expires_on, status, bitpanel_list_id)
           VALUES ($1, $2, CURRENT_DATE, $3, $4, $5)`,
          [customer.rows[0].id, plan.rows[0].id, item.expiresOn, item.status, item.bitpanelListId]
        );
        stats.imported += 1;
      });
    } catch (error) {
      stats.errors.push({
        row: index + 1,
        bitpanelListId: item.bitpanelListId,
        error: error.message
      });
    }
  }
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'customer.bitpanel_imported',
    entityType: 'customer',
    after: { imported: stats.imported, updated: stats.updated, errorCount: stats.errors.length },
    ip: request.ip
  });
  return stats;
});

app.post('/api/admin/customers', { preHandler: requireAuth }, async (request, reply) => {
  const body = parse(
    z.object({
      name: z.string().min(2).max(120),
      whatsapp: z.string().min(10).max(30),
      planCode: z.enum(['monthly', 'quarterly']),
      expiresOn: z.iso.date(),
      bitpanelListId: z.string().max(100).optional(),
      bitpanelReference: z.string().max(120).optional(),
      consentContact: z.boolean().default(true)
    }),
    request.body
  );
  const phone = normalizePhone(body.whatsapp);
  const portalToken = randomToken(24);
  const result = await db.transaction(async (client) => {
    const plan = await client.query('SELECT id FROM plans WHERE code = $1', [body.planCode]);
    if (!plan.rows[0]) throw new Error('Plano não encontrado.');
    const customer = await client.query(
      `INSERT INTO customers
        (name, whatsapp_e164, bitpanel_reference, source, status, consent_contact, portal_token_hash)
       VALUES ($1, $2, $3, 'manual', 'active', $4, $5)
       RETURNING id`,
      [body.name, phone, body.bitpanelReference || null, body.consentContact, sha256(portalToken)]
    );
    const subscription = await client.query(
      `INSERT INTO subscriptions
        (customer_id, plan_id, starts_on, expires_on, status, bitpanel_list_id)
       VALUES ($1, $2, CURRENT_DATE, $3, 'active', $4)
       RETURNING id`,
      [customer.rows[0].id, plan.rows[0].id, body.expiresOn, body.bitpanelListId || null]
    );
    return { customerId: customer.rows[0].id, subscriptionId: subscription.rows[0].id };
  });
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'customer.created',
    entityType: 'customer',
    entityId: result.customerId,
    after: { ...body, whatsapp: maskPhone(phone) },
    ip: request.ip
  });
  return reply.code(201).send({
    ...result,
    portalUrl: config.PUBLIC_BASE_URL
      ? `${config.PUBLIC_BASE_URL}/cliente/${portalToken}`
      : `/cliente/${portalToken}`
  });
});

app.post('/api/admin/customers/:id/portal-link', { preHandler: requireAuth }, async (request, reply) => {
  const portalToken = randomToken(24);
  const result = await db.query(
    `UPDATE customers
        SET portal_token_hash = $2, updated_at = now()
      WHERE id = $1
      RETURNING id`,
    [request.params.id, sha256(portalToken)]
  );
  if (!result.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado.' });
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'customer.portal_access_issued',
    entityType: 'customer',
    entityId: result.rows[0].id,
    ip: request.ip
  });
  return {
    portalUrl: config.PUBLIC_BASE_URL
      ? `${config.PUBLIC_BASE_URL}/cliente/${portalToken}`
      : `/cliente/${portalToken}`
  };
});

app.post('/api/admin/customers/import', { preHandler: requireAuth }, async (request) => {
  const body = parse(
    z.object({
      customers: z
        .array(
          z.object({
            name: z.string().min(2).max(120).optional(),
            whatsapp: z.string().min(10).max(30).optional(),
            plan: z.enum(['monthly', 'quarterly', 'mensal', 'trimestral']),
            expiresOn: z.iso.date(),
            bitpanelListId: z.string().max(100).optional(),
            bitpanelReference: z.string().max(120).optional(),
            status: z.enum(['active', 'late', 'suspended', 'cancelled']).default('active'),
            consentContact: z.boolean().default(true)
          })
        )
        .min(1)
        .max(2000)
    }),
    request.body
  );
  const stats = { imported: 0, errors: [] };
  for (const [index, item] of body.customers.entries()) {
    try {
      if (!item.whatsapp && !item.bitpanelListId) {
        throw new Error('Informe o WhatsApp ou o ID da lista BitPanel.');
      }
      const phone = item.whatsapp ? normalizePhone(item.whatsapp) : null;
      const planCode = item.plan === 'mensal' ? 'monthly' : item.plan === 'trimestral' ? 'quarterly' : item.plan;
      await db.transaction(async (client) => {
        const plan = await client.query('SELECT id FROM plans WHERE code = $1', [planCode]);
        const linked = item.bitpanelListId
          ? await client.query(
              `SELECT c.id
                 FROM subscriptions s JOIN customers c ON c.id = s.customer_id
                WHERE s.bitpanel_list_id = $1
                ORDER BY s.created_at DESC LIMIT 1`,
              [item.bitpanelListId]
            )
          : { rows: [] };
        let customer;
        if (linked.rows[0]) {
          customer = await client.query(
            `UPDATE customers
                SET name = COALESCE($2, name),
                    whatsapp_e164 = COALESCE($3, whatsapp_e164),
                    bitpanel_reference = COALESCE($4, bitpanel_reference),
                    status = $5, consent_contact = $6, updated_at = now()
              WHERE id = $1 RETURNING id`,
            [linked.rows[0].id, item.name || null, phone, item.bitpanelReference || null, item.status, item.consentContact]
          );
        } else {
          customer = await client.query(
            `INSERT INTO customers
              (name, whatsapp_e164, bitpanel_reference, source, status, consent_contact)
             VALUES ($1, $2, $3, 'import', $4, $5)
             ON CONFLICT (whatsapp_e164) DO UPDATE
               SET name = COALESCE(EXCLUDED.name, customers.name),
                   bitpanel_reference = COALESCE(EXCLUDED.bitpanel_reference, customers.bitpanel_reference),
                   status = EXCLUDED.status,
                   consent_contact = EXCLUDED.consent_contact,
                   updated_at = now()
             RETURNING id`,
            [item.name || null, phone, item.bitpanelReference || null, item.status, item.consentContact]
          );
        }
        await client.query(
          `WITH latest AS (
           SELECT id FROM subscriptions
              WHERE customer_id = $1
              ORDER BY created_at DESC LIMIT 1
           )
           UPDATE subscriptions
              SET plan_id = $2, expires_on = $3, status = $4,
                  bitpanel_list_id = COALESCE($5, bitpanel_list_id), updated_at = now()
            WHERE id = (SELECT id FROM latest)`,
          [customer.rows[0].id, plan.rows[0].id, item.expiresOn, item.status, item.bitpanelListId || null]
        );
        await client.query(
          `INSERT INTO subscriptions
            (customer_id, plan_id, starts_on, expires_on, status, bitpanel_list_id)
           SELECT $1, $2, CURRENT_DATE, $3, $4, $5
            WHERE NOT EXISTS (
              SELECT 1 FROM subscriptions WHERE customer_id = $1
            )`,
          [customer.rows[0].id, plan.rows[0].id, item.expiresOn, item.status, item.bitpanelListId || null]
        );
      });
      stats.imported += 1;
    } catch (error) {
      stats.errors.push({ row: index + 1, name: item.name || item.bitpanelReference, error: error.message });
    }
  }
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'customer.imported',
    entityType: 'customer',
    after: { imported: stats.imported, errorCount: stats.errors.length },
    ip: request.ip
  });
  return stats;
});

app.get('/api/admin/charges', { preHandler: requireAuth }, async (request) => {
  const status = String(request.query?.status || '');
  const result = await db.query(
    `SELECT ch.id, ch.stage, ch.status, ch.amount_cents, ch.due_on::text,
            ch.message_text, ch.approved_at, ch.paid_at, ch.pix_ticket_url,
            c.name AS customer_name, c.whatsapp_e164,
            p.name AS plan_name
       FROM charges ch
       JOIN subscriptions s ON s.id = ch.subscription_id
       JOIN customers c ON c.id = s.customer_id
       JOIN plans p ON p.id = COALESCE(ch.plan_id, s.plan_id)
      WHERE ($1 = '' OR ch.status = $1)
      ORDER BY
        CASE ch.status WHEN 'awaiting_approval' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
        ch.due_on, ch.created_at DESC
      LIMIT 500`,
    [status]
  );
  return {
    charges: result.rows.map((row) => ({ ...row, whatsapp_masked: maskPhone(row.whatsapp_e164) }))
  };
});

app.post('/api/admin/billing/scan', { preHandler: requireAuth }, async (request) => {
  const stats = await scanBilling(db, { timezone: config.TIMEZONE });
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'billing.scan_manual',
    entityType: 'billing',
    after: stats,
    ip: request.ip
  });
  return stats;
});

app.post('/api/admin/charges/:id/approve', { preHandler: requireAuth }, async (request, reply) => {
  if (!requireQueues(reply)) return;
  const result = await db.query(
    `UPDATE charges
        SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('awaiting_approval', 'approved')
      RETURNING id, content_version`,
    [request.params.id, request.user.id]
  );
  if (!result.rows[0]) return reply.code(409).send({ error: 'Cobrança não pode ser aprovada.' });
  await queues.messages.add(
    'send-charge',
    { chargeId: result.rows[0].id },
    {
      jobId: `charge-${result.rows[0].id}-v${result.rows[0].content_version}-${Date.now()}`,
      attempts: 20,
      backoff: { type: 'fixed', delay: 300_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000
    }
  );
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'billing.charge_approved',
    entityType: 'charge',
    entityId: result.rows[0].id,
    ip: request.ip
  });
  return { ok: true, queued: true };
});

app.post('/api/admin/charges/:id/reject', { preHandler: requireAuth }, async (request, reply) => {
  const result = await db.query(
    `UPDATE charges SET status = 'rejected', updated_at = now()
      WHERE id = $1 AND status IN ('draft', 'awaiting_approval')
      RETURNING id`,
    [request.params.id]
  );
  if (!result.rows[0]) return reply.code(409).send({ error: 'Cobrança não pode ser rejeitada.' });
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'billing.charge_rejected',
    entityType: 'charge',
    entityId: result.rows[0].id,
    ip: request.ip
  });
  return { ok: true };
});

app.post('/api/admin/charges/:id/mark-paid', { preHandler: requireAuth }, async (request, reply) => {
  const marked = await markPaymentApproved(db, request.params.id, { id: `MANUAL-${Date.now()}` });
  const automation = await maybeQueueBitPanelJob(marked.renewalId, request.user.id);
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'billing.payment_confirmed_manual',
    entityType: 'charge',
    entityId: request.params.id,
    ip: request.ip
  });
  return reply.send({ ok: true, duplicate: marked.duplicate, automation });
});

app.get('/api/admin/renewals', { preHandler: requireAuth }, async () => {
  const result = await db.query(
    `SELECT r.id, r.status, r.attempts, r.before_expiry, r.after_expiry, r.error,
            r.created_at, ch.id AS charge_id, c.name AS customer_name,
            c.bitpanel_reference, s.bitpanel_list_id, s.expires_on::text,
            p.name AS plan_name, p.duration_months,
            CASE
              WHEN ch.stage = 'new_sale' OR s.bitpanel_list_id IS NULL THEN 'provision'
              ELSE 'renew'
            END AS operation
       FROM renewal_jobs r
       JOIN charges ch ON ch.id = r.charge_id
       JOIN subscriptions s ON s.id = ch.subscription_id
       JOIN customers c ON c.id = s.customer_id
       JOIN plans p ON p.id = COALESCE(ch.plan_id, s.plan_id)
      ORDER BY CASE r.status WHEN 'awaiting_approval' THEN 0 WHEN 'manual_review' THEN 1 ELSE 2 END,
               r.created_at DESC
      LIMIT 300`
  );
  return { renewals: result.rows };
});

app.post('/api/admin/renewals/:id/approve', { preHandler: requireAuth }, async (request, reply) => {
  if (!requireQueues(reply)) return;
  const result = await db.query(
    `UPDATE renewal_jobs
        SET status = 'queued', approved_by = $2, approved_at = now(), error = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('awaiting_approval', 'manual_review', 'simulated')
      RETURNING id`,
    [request.params.id, request.user.id]
  );
  if (!result.rows[0]) return reply.code(409).send({ error: 'Renovação não pode ser executada.' });
  await queues.renewals.add(
    'execute-renewal',
    { renewalId: result.rows[0].id },
    {
      jobId: `renewal-${result.rows[0].id}-${Date.now()}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000
    }
  );
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'bitpanel.renewal_approved',
    entityType: 'renewal_job',
    entityId: result.rows[0].id,
    ip: request.ip
  });
  return { ok: true, queued: true };
});

app.get('/api/admin/leads', { preHandler: requireAuth }, async () => {
  const result = await db.query(
    `SELECT id, name, whatsapp_e164, source, campaign, desired_plan, status, created_at
       FROM leads ORDER BY created_at DESC LIMIT 500`
  );
  return {
    leads: result.rows.map((row) => ({ ...row, whatsapp_masked: maskPhone(row.whatsapp_e164) }))
  };
});

app.get('/api/admin/settings', { preHandler: requireAuth }, async () => {
  const keys = [
    'global_pause',
    'sales_mode',
    'payment_mode',
    'whatsapp_mode',
    'bitpanel_mode',
    'renewal_requires_approval'
  ];
  const values = Object.fromEntries(
    await Promise.all(keys.map(async (key) => [key, await getSetting(db, key, null)]))
  );
  const mercadoPago = getMercadoPagoReadiness(config);
  return {
    settings: values,
    integrations: {
      redis: Boolean(config.REDIS_URL),
      mercadoPago: mercadoPago.ready,
      whatsapp: Boolean(config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID),
      bitpanel: Boolean(config.BITPANEL_USERNAME && config.BITPANEL_PASSWORD)
    },
    mercadoPago
  };
});

app.put('/api/admin/settings', { preHandler: requireAuth }, async (request) => {
  const body = parse(
    z.object({
      global_pause: z.boolean().optional(),
      sales_mode: z.enum(['simulation', 'approval', 'automatic']).optional(),
      payment_mode: z.enum(['simulation', 'live']).optional(),
      whatsapp_mode: z.enum(['simulation', 'live']).optional(),
      bitpanel_mode: z.enum(['disabled', 'simulation', 'live']).optional(),
      renewal_requires_approval: z.boolean().optional()
    }),
    request.body
  );
  if (body.payment_mode === 'live' && !getMercadoPagoReadiness(config).ready) {
    const error = new Error(
      'Configure o Access Token de produção, o segredo e o webhook do Mercado Pago antes do modo real.'
    );
    error.statusCode = 409;
    throw error;
  }
  if (
    body.whatsapp_mode === 'live' &&
    (!config.WHATSAPP_ACCESS_TOKEN ||
      !config.WHATSAPP_PHONE_NUMBER_ID ||
      !config.WHATSAPP_VERIFY_TOKEN ||
      !config.META_APP_SECRET)
  ) {
    const error = new Error('Configure tokens, número e assinatura da Meta antes do modo real.');
    error.statusCode = 409;
    throw error;
  }
  if (
    body.bitpanel_mode === 'live' &&
    (!config.BITPANEL_USERNAME || !config.BITPANEL_PASSWORD)
  ) {
    const error = new Error('Configure o usuário e a senha do BitPanel antes do modo real.');
    error.statusCode = 409;
    throw error;
  }
  for (const [key, value] of Object.entries(body)) {
    await setSetting(db, key, value, request.user.id);
  }
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'settings.updated',
    entityType: 'system_settings',
    after: body,
    ip: request.ip
  });
  return { ok: true };
});

app.get('/api/portal/:token', async (request, reply) => {
  const result = await db.query(
    `SELECT c.id AS customer_id, c.name, c.status, s.expires_on::text,
            p.code AS plan_code, p.name AS plan_name, p.price_cents,
            COALESCE((SELECT sum(points) FROM loyalty_ledger l WHERE l.customer_id = c.id), 0)::int AS points
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT * FROM subscriptions WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE c.portal_token_hash = $1`,
    [sha256(request.params.token)]
  );
  if (!result.rows[0]) return reply.code(404).send({ error: 'Acesso do cliente inválido.' });
  const customer = result.rows[0];
  const [plans, pending] = await Promise.all([
    db.query(
      'SELECT code, name, duration_months, price_cents FROM plans WHERE active = true ORDER BY sort_order'
    ),
    db.query(
      `SELECT ch.status, ch.amount_cents, ch.created_at, p.code AS plan_code, p.name AS plan_name
         FROM charges ch
         JOIN subscriptions s ON s.id = ch.subscription_id
         JOIN plans p ON p.id = COALESCE(ch.plan_id, s.plan_id)
        WHERE s.customer_id = $1
          AND ch.stage = 'manual'
          AND ch.status IN ('awaiting_approval', 'approved', 'sent')
        ORDER BY ch.created_at DESC
        LIMIT 1`,
      [customer.customer_id]
    )
  ]);
  delete customer.customer_id;
  return {
    ...customer,
    plans: plans.rows,
    pending_renewal: pending.rows[0] || null,
    whatsapp_url: config.PUBLIC_WHATSAPP_NUMBER
      ? `https://wa.me/${config.PUBLIC_WHATSAPP_NUMBER}`
      : null
  };
});

app.post(
  '/api/portal/:token/renewals',
  { config: { rateLimit: { max: 6, timeWindow: '1 hour' } } },
  async (request, reply) => {
    const body = parse(
      z.object({ planCode: z.enum(['monthly', 'quarterly']) }),
      request.body
    );
    const portalHash = sha256(request.params.token);
    const [globalPause, salesMode] = await Promise.all([
      getSetting(db, 'global_pause', config.GLOBAL_PAUSE),
      getSetting(db, 'sales_mode', config.SALES_MODE)
    ]);
    const initialStatus = !globalPause && salesMode === 'automatic'
      ? 'approved'
      : 'awaiting_approval';

    const created = await db.transaction(async (client) => {
      const customerResult = await client.query(
        `SELECT c.id, c.name, c.whatsapp_e164, c.consent_contact,
                s.id AS subscription_id, s.expires_on::text
           FROM customers c
           JOIN LATERAL (
             SELECT * FROM subscriptions
              WHERE customer_id = c.id AND status <> 'cancelled'
              ORDER BY created_at DESC LIMIT 1
           ) s ON true
          WHERE c.portal_token_hash = $1
          FOR UPDATE OF c`,
        [portalHash]
      );
      const customer = customerResult.rows[0];
      if (!customer) {
        const error = new Error('Acesso do cliente inválido.');
        error.statusCode = 404;
        throw error;
      }
      const planResult = await client.query(
        'SELECT id, code, name, price_cents FROM plans WHERE code = $1 AND active = true',
        [body.planCode]
      );
      const plan = planResult.rows[0];
      if (!plan) {
        const error = new Error('Plano indisponível.');
        error.statusCode = 409;
        throw error;
      }
      const idempotencyKey = buildIdempotencyKey(
        customer.subscription_id,
        `portal-${plan.code}`,
        customer.expires_on
      );
      const message = renderChargeMessage({
        name: customer.name,
        planName: plan.name,
        expiresOn: customer.expires_on,
        amountCents: plan.price_cents,
        stage: 'manual'
      });
      const chargeResult = await client.query(
        `INSERT INTO charges
          (subscription_id, plan_id, stage, status, amount_cents, due_on,
           idempotency_key, message_text)
         VALUES ($1, $2, 'manual', $3, $4, CURRENT_DATE, $5, $6)
         ON CONFLICT (idempotency_key) DO UPDATE
           SET updated_at = charges.updated_at
         RETURNING id, status, amount_cents`,
        [
          customer.subscription_id,
          plan.id,
          initialStatus,
          plan.price_cents,
          idempotencyKey,
          message
        ]
      );
      return {
        ...chargeResult.rows[0],
        customerId: customer.id,
        customerPhone: customer.whatsapp_e164,
        planCode: plan.code,
        planName: plan.name
      };
    });

    let queued = false;
    if (created.status === 'approved' && queues) {
      await queues.messages.add(
        'send-charge',
        { chargeId: created.id },
        {
          jobId: `portal-charge-${created.id}`,
          attempts: 20,
          backoff: { type: 'fixed', delay: 300_000 },
          removeOnComplete: 1000,
          removeOnFail: 2000
        }
      );
      queued = true;
    }
    await audit(db, {
      actorType: 'customer',
      actorId: created.customerId,
      action: 'billing.portal_renewal_requested',
      entityType: 'charge',
      entityId: created.id,
      after: {
        planCode: created.planCode,
        status: created.status,
        queued
      },
      ip: request.ip
    });
    return reply.code(201).send({
      ok: true,
      status: created.status,
      queued,
      planName: created.planName,
      message: created.status === 'approved'
        ? 'Pedido confirmado. O Pix será enviado pelo WhatsApp.'
        : 'Pedido recebido. O Pix será enviado pelo WhatsApp assim que a cobrança for aprovada.'
    });
  }
);

app.get('/cliente/:token', async (_request, reply) => reply.sendFile('portal.html'));
app.get('/captacao', async (_request, reply) => reply.sendFile('landing.html'));
app.get('/', async (_request, reply) => reply.sendFile('index.html'));

app.setErrorHandler((error, request, reply) => {
  const statusCode =
    error.code === '23505'
      ? 409
      : error.statusCode && error.statusCode < 500
        ? error.statusCode
        : 500;
  if (statusCode >= 500) {
    app.log.error(
      { error: error.message, route: request.routeOptions?.url, data: sanitizeForLog(error) },
      'Erro na aplicação'
    );
  }
  reply.code(statusCode).send({
    error:
      error.code === '23505'
        ? 'Já existe um cadastro com esses dados.'
        : statusCode >= 500
          ? 'Não foi possível concluir a operação.'
          : error.message
  });
});

async function start() {
  await initializeDatabase(db, config);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info({ port: config.PORT }, 'Gate One Pro iniciado');
}

const shutdown = async () => {
  await app.close();
  if (queues) await Promise.all([queues.messages.close(), queues.renewals.close()]);
  if (redis) await redis.quit();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(async (error) => {
  app.log.error(error);
  await db.close();
  process.exit(1);
});
