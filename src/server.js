import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
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
  createCheckoutPreference,
  getMercadoPagoPayment,
  getMercadoPagoReadiness,
  verifyMercadoPagoWebhook
} from './integrations/mercadopago.js';
import {
  parseWhatsAppWebhook,
  verifyMetaSignature
} from './integrations/whatsapp.js';
import { handleInboundMessage } from './services/sales.js';
import {
  credentialStatus,
  getRuntimeConfig,
  saveIntegrationCredentials
} from './integrations/runtime-config.js';
import { fetchBitPanelCustomers, testBitPanelConnection } from './integrations/bitpanel.js';
import { testOpenAIConnection } from './integrations/openai.js';
import { parseCustomerSpreadsheet } from './importers/spreadsheet.js';
import { answerAdminQuestion } from './services/ai-support.js';

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
      '*.OPENAI_API_KEY',
      '*.pix_copy_paste'
    ]
  },
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024
});

await app.register(cookie, { secret: config.COOKIE_SECRET });
await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
await app.register(multipart, {
  limits: { files: 1, fileSize: 5 * 1024 * 1024 }
});
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

function safeBitPanelSyncError(error) {
  const message = String(error?.message || '');
  const knownMessages = [
    'Credenciais do BitPanel não configuradas na Railway.',
    'Tela de login do BitPanel mudou. Revisão manual necessária.',
    'Busca de listas do BitPanel não encontrada.',
    'O BitPanel recusou o acesso. Confira o usuário e a senha em Configurações.',
    'Não foi possível gravar os clientes sincronizados.'
  ];
  if (knownMessages.includes(message)) return message;
  if (/timeout|waiting for|locator/i.test(message)) {
    return 'O BitPanel demorou para responder ou a tela de clientes mudou. Teste a conexão e tente novamente.';
  }
  if (/net::|navigation|ERR_/i.test(message)) {
    return 'Não foi possível acessar o endereço do BitPanel. Confira as URLs salvas em Configurações.';
  }
  if (/login|credential|password|unauthorized|forbidden/i.test(message)) {
    return 'O BitPanel recusou o acesso. Confira o usuário e a senha em Configurações.';
  }
  return 'O BitPanel não concluiu a sincronização. Use “Testar conexão” em Configurações e tente novamente.';
}

function normalizeDesiredLogin(value) {
  const login = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{4,32}$/.test(login)) {
    throw Object.assign(
      new Error('O login deve ter de 4 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.'),
      { statusCode: 400 }
    );
  }
  return login;
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
  const [paused, requiresApproval, bitpanelMode, eligibility] = await Promise.all([
    getSetting(db, 'global_pause', config.GLOBAL_PAUSE),
    getSetting(db, 'renewal_requires_approval', config.RENEWAL_REQUIRES_APPROVAL),
    getSetting(db, 'bitpanel_mode', config.BITPANEL_MODE),
    db.query(
      `SELECT ch.status AS charge_status, ch.stage, s.bitpanel_list_id,
              c.bitpanel_owner, c.automation_eligible
         FROM renewal_jobs r
         JOIN charges ch ON ch.id = r.charge_id
         JOIN subscriptions s ON s.id = ch.subscription_id
         JOIN customers c ON c.id = s.customer_id
        WHERE r.id = $1`,
      [renewalId]
    )
  ]);
  if (paused) return { queued: false, reason: 'global_pause' };
  if (requiresApproval) return { queued: false, reason: 'approval_required' };
  if (bitpanelMode !== 'live') return { queued: false, reason: 'bitpanel_not_live' };
  const target = eligibility.rows[0];
  if (!target || target.charge_status !== 'paid') {
    return { queued: false, reason: 'payment_not_confirmed' };
  }
  const isProvision = target.stage === 'new_sale' || !target.bitpanel_list_id;
  if (
    !isProvision &&
    (!target.automation_eligible || target.bitpanel_owner !== 'Gate One Pro Server')
  ) {
    return { queued: false, reason: 'customer_not_eligible' };
  }

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
    'SELECT code, name, duration_months, price_cents, description FROM plans WHERE active = true ORDER BY sort_order'
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
        email: z.email().max(254),
        whatsapp: z.string().min(10).max(30),
        desiredLogin: z.string().min(4).max(32),
        desiredPlan: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']).optional(),
        campaign: z.string().max(100).optional(),
        consent: z.literal(true)
      }),
      request.body
    );
    const phone = normalizePhone(body.whatsapp);
    const desiredLogin = normalizeDesiredLogin(body.desiredLogin);
    if (!body.desiredPlan) {
      return reply.code(400).send({ error: 'Escolha um plano para continuar ao pagamento.' });
    }
    const runtimeConfig = {
      ...(await getRuntimeConfig(db, config)),
      PAYMENT_MODE: await getSetting(db, 'payment_mode', config.PAYMENT_MODE)
    };
    const created = await db.transaction(async (client) => {
      const planResult = await client.query(
        'SELECT * FROM plans WHERE code = $1 AND active = true',
        [body.desiredPlan]
      );
      const plan = planResult.rows[0];
      if (!plan) throw Object.assign(new Error('Plano indisponível.'), { statusCode: 409 });
      const loginInUse = await client.query(
        `SELECT id FROM customers
          WHERE lower(COALESCE(bitpanel_reference, '')) = $1
            AND COALESCE(whatsapp_e164, '') <> $2
          LIMIT 1`,
        [desiredLogin, phone]
      );
      if (loginInUse.rows[0]) {
        throw Object.assign(new Error('Esse login já foi escolhido. Tente outro.'), { statusCode: 409 });
      }
      const lead = await client.query(
        `INSERT INTO leads (name, whatsapp_e164, source, campaign, desired_plan, status)
         VALUES ($1, $2, 'landing_page', $3, $4, 'payment_pending')
         RETURNING id`,
        [body.name, phone, body.campaign || null, body.desiredPlan]
      );
      const customer = await client.query(
        `INSERT INTO customers (name, email, whatsapp_e164, bitpanel_reference, source, status, consent_contact)
         VALUES ($1, $2, $3, $4, 'landing_page', 'lead', true)
         ON CONFLICT (whatsapp_e164) DO UPDATE
           SET name = EXCLUDED.name, email = EXCLUDED.email,
               bitpanel_reference = EXCLUDED.bitpanel_reference,
               consent_contact = true, updated_at = now()
         RETURNING id, name, email, bitpanel_reference`,
        [body.name, body.email.toLowerCase(), phone, desiredLogin]
      );
      let subscription = await client.query(
        `SELECT id, expires_on::text FROM subscriptions
          WHERE customer_id = $1 AND status <> 'cancelled'
          ORDER BY created_at DESC LIMIT 1`,
        [customer.rows[0].id]
      );
      if (!subscription.rows[0]) {
        subscription = await client.query(
          `INSERT INTO subscriptions
            (customer_id, plan_id, starts_on, expires_on, status)
           VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, 'pending')
           RETURNING id, expires_on::text`,
          [customer.rows[0].id, plan.id]
        );
      }
      const idempotencyKey = buildIdempotencyKey(
        subscription.rows[0].id,
        `checkout-${plan.code}`,
        new Date().toISOString().slice(0, 13)
      );
      const charge = await client.query(
        `INSERT INTO charges
          (subscription_id, plan_id, stage, status, amount_cents, due_on,
           idempotency_key, message_text)
         VALUES ($1, $2, 'new_sale', 'approved', $3, CURRENT_DATE, $4, $5)
         ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
         RETURNING id, idempotency_key, amount_cents`,
        [
          subscription.rows[0].id,
          plan.id,
          plan.price_cents,
          idempotencyKey,
          renderChargeMessage({
            name: body.name,
            planName: plan.name,
            expiresOn: subscription.rows[0].expires_on,
            amountCents: plan.price_cents,
            stage: 'new_sale'
          })
        ]
      );
      return {
        leadId: lead.rows[0].id,
        customerId: customer.rows[0].id,
        customer_name: body.name,
        customer_email: customer.rows[0].email,
        customer_phone: phone,
        desired_login: customer.rows[0].bitpanel_reference,
        plan_code: plan.code,
        plan_name: plan.name,
        duration_months: plan.duration_months,
        ...charge.rows[0]
      };
    });
    const preference = await createCheckoutPreference(runtimeConfig, created);
    await db.query(
      `UPDATE charges
          SET mercado_pago_preference_id = $2, checkout_url = $3, updated_at = now()
        WHERE id = $1`,
      [created.id, preference.id, preference.checkoutUrl]
    );
    await audit(db, {
      actorType: 'lead',
      actorId: phone,
      action: 'lead.captured',
      entityType: 'lead',
      entityId: created.leadId,
      ip: request.ip
    });
    return reply.code(201).send({
      ok: true,
      message: 'Abrindo o ambiente seguro do Mercado Pago…',
      checkoutUrl: preference.checkoutUrl
    });
  }
);

app.get('/webhooks/whatsapp', async (request, reply) => {
  const runtimeConfig = await getRuntimeConfig(db, config);
  const query = request.query || {};
  if (
    query['hub.mode'] === 'subscribe' &&
    query['hub.verify_token'] &&
    query['hub.verify_token'] === runtimeConfig.WHATSAPP_VERIFY_TOKEN
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
    const runtimeConfig = {
      ...(await getRuntimeConfig(db, config)),
      WHATSAPP_MODE: whatsappMode
    };
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
        await handleInboundMessage({ db, queues, config: runtimeConfig, inbound });
      } catch (error) {
        app.log.error({ messageId: inbound.id, error: error.message }, 'Falha no atendimento');
      }
    }
    return { received: true };
  }
);

app.post('/webhooks/mercadopago', async (request, reply) => {
  const paymentMode = await getSetting(db, 'payment_mode', config.PAYMENT_MODE);
  const runtimeConfig = {
    ...(await getRuntimeConfig(db, config)),
    PAYMENT_MODE: paymentMode
  };
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

app.get('/api/admin/analytics', { preHandler: requireAuth }, async () => {
  const [
    revenueTrend,
    chargeStatus,
    customerStatus,
    renewalStatus,
    expirations,
    automation,
    settings
  ] = await Promise.all([
    db.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', now()) - interval '5 months',
           date_trunc('month', now()),
           interval '1 month'
         ) AS month
       )
       SELECT to_char(months.month, 'YYYY-MM') AS month,
              COALESCE(sum(ch.amount_cents), 0)::int AS cents
         FROM months
         LEFT JOIN charges ch
           ON ch.status = 'paid'
          AND ch.paid_at >= months.month
          AND ch.paid_at < months.month + interval '1 month'
        GROUP BY months.month
        ORDER BY months.month`
    ),
    db.query(
      `SELECT status, count(*)::int AS total
         FROM charges
        GROUP BY status ORDER BY total DESC`
    ),
    db.query(
      `SELECT status, count(*)::int AS total
         FROM customers
        GROUP BY status ORDER BY total DESC`
    ),
    db.query(
      `SELECT status, count(*)::int AS total
         FROM renewal_jobs
        GROUP BY status ORDER BY total DESC`
    ),
    db.query(
      `SELECT
         count(*) FILTER (WHERE expires_on < CURRENT_DATE)::int AS overdue,
         count(*) FILTER (WHERE expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS next7,
         count(*) FILTER (WHERE expires_on BETWEEN CURRENT_DATE + 8 AND CURRENT_DATE + 15)::int AS next15,
         count(*) FILTER (WHERE expires_on BETWEEN CURRENT_DATE + 16 AND CURRENT_DATE + 30)::int AS next30
       FROM subscriptions
       WHERE status IN ('active', 'late')`
    ),
    db.query(
      `SELECT
         count(*) FILTER (
           WHERE status = 'completed' AND updated_at >= now() - interval '30 days'
         )::int AS completed_30d,
         count(*) FILTER (
           WHERE status IN ('failed', 'manual_review') AND updated_at >= now() - interval '30 days'
         )::int AS failed_30d,
         max(updated_at) FILTER (WHERE status = 'completed') AS last_completed_at,
         max(updated_at) FILTER (WHERE status IN ('failed', 'manual_review')) AS last_failed_at
       FROM renewal_jobs`
    ),
    Promise.all([
      getSetting(db, 'global_pause', config.GLOBAL_PAUSE),
      getSetting(db, 'payment_mode', config.PAYMENT_MODE),
      getSetting(db, 'bitpanel_mode', config.BITPANEL_MODE),
      getSetting(db, 'renewal_requires_approval', config.RENEWAL_REQUIRES_APPROVAL)
    ])
  ]);
  const completed = automation.rows[0].completed_30d;
  const failed = automation.rows[0].failed_30d;
  return {
    revenueTrend: revenueTrend.rows,
    chargeStatus: chargeStatus.rows,
    customerStatus: customerStatus.rows,
    renewalStatus: renewalStatus.rows,
    expirations: expirations.rows[0],
    automation: {
      ...automation.rows[0],
      successRate30d: completed + failed ? Math.round((completed / (completed + failed)) * 100) : null,
      active:
        !settings[0] &&
        settings[1] === 'live' &&
        settings[2] === 'live' &&
        settings[3] === false
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
            c.bitpanel_reference, c.bitpanel_owner, c.automation_eligible, c.created_at,
            s.id AS subscription_id, s.expires_on::text, s.bitpanel_list_id,
            p.code AS plan_code, p.name AS plan_name, p.price_cents
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT * FROM subscriptions
          WHERE customer_id = c.id
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
                    status = $3, bitpanel_owner = $4,
                    automation_eligible = $5, updated_at = now()
              WHERE id = $1`,
            [
              existing.rows[0].customer_id,
              item.bitpanelReference,
              item.status,
              item.owner || null,
              item.owner === 'Gate One Pro Server'
            ]
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
            (name, whatsapp_e164, bitpanel_reference, bitpanel_owner,
             automation_eligible, source, status, consent_contact)
           VALUES (NULL, NULL, $1, $3, $4, 'bitpanel', $2, false)
           RETURNING id`,
          [
            item.bitpanelReference,
            item.status,
            item.owner || null,
            item.owner === 'Gate One Pro Server'
          ]
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

app.post('/api/admin/customers/sync-bitpanel', { preHandler: requireAuth }, async (request) => {
  try {
    const runtimeConfig = await getRuntimeConfig(db, config);
    const customers = await fetchBitPanelCustomers(runtimeConfig);
    const result = await app.inject({
      method: 'POST',
      url: '/api/admin/customers/import-bitpanel',
      headers: { cookie: request.headers.cookie || '' },
      payload: { customers }
    });
    if (result.statusCode >= 400) {
      request.log.error(
        { statusCode: result.statusCode, response: sanitizeForLog(result.json()) },
        'Falha ao gravar clientes sincronizados'
      );
      throw new Error('Não foi possível gravar os clientes sincronizados.');
    }
    const stats = result.json();
    const blocked = customers.filter((item) => item.owner !== 'Gate One Pro Server').length;
    return { ...stats, found: customers.length, blocked };
  } catch (error) {
    request.log.error(
      { error: error.message, data: sanitizeForLog(error) },
      'Falha na sincronização do BitPanel'
    );
    throw Object.assign(new Error(safeBitPanelSyncError(error)), { statusCode: 502 });
  }
});

app.post('/api/admin/customers', { preHandler: requireAuth }, async (request, reply) => {
  const body = parse(
    z.object({
      name: z.string().min(2).max(120),
      whatsapp: z.string().min(10).max(30),
      planCode: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']),
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

app.patch('/api/admin/customers/:id', { preHandler: requireAuth }, async (request, reply) => {
  const body = parse(
    z.object({
      name: z.string().max(120).optional(),
      whatsapp: z.string().max(30).optional(),
      planCode: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']),
      expiresOn: z.iso.date(),
      // Front-end forms from older deployments occasionally submit an empty
      // status. Treat it as active instead of rejecting a whole edit.
      status: z.preprocess(
        (value) => (String(value || '').trim() === '' ? undefined : value),
        z.enum(['active', 'late', 'suspended', 'cancelled']).optional().default('active')
      ),
      bitpanelListId: z.string().max(100).optional(),
      bitpanelReference: z.string().max(120).optional(),
      bitpanelOwner: z.string().max(120).optional(),
      consentContact: z.boolean().default(false)
    }),
    request.body
  );
  const phone = body.whatsapp?.trim() ? normalizePhone(body.whatsapp) : null;
  const result = await db.transaction(async (client) => {
    const before = await client.query(
      `SELECT c.*, s.id AS subscription_id, s.expires_on::text, s.bitpanel_list_id,
              p.code AS plan_code
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT * FROM subscriptions
            WHERE customer_id = c.id
            ORDER BY created_at DESC LIMIT 1
         ) s ON true
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE c.id = $1`,
      [request.params.id]
    );
    if (!before.rows[0]) return null;
    const plan = await client.query('SELECT id FROM plans WHERE code = $1', [body.planCode]);
    if (!plan.rows[0]) throw new Error('Plano não encontrado.');
    const customer = await client.query(
      `UPDATE customers
          SET name = $2, whatsapp_e164 = $3, bitpanel_reference = $4,
              bitpanel_owner = $5, automation_eligible = $6, status = $7,
              consent_contact = $8, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        request.params.id,
        body.name?.trim() || null,
        phone,
        body.bitpanelReference?.trim() || null,
        body.bitpanelOwner?.trim() || null,
        body.bitpanelOwner?.trim() === 'Gate One Pro Server',
        body.status,
        Boolean(phone && body.consentContact)
      ]
    );
    if (before.rows[0].subscription_id) {
      await client.query(
        `UPDATE subscriptions
            SET plan_id = $2, expires_on = $3, status = $4,
                bitpanel_list_id = $5, updated_at = now()
          WHERE id = $1`,
        [
          before.rows[0].subscription_id,
          plan.rows[0].id,
          body.expiresOn,
          body.status,
          body.bitpanelListId?.trim() || null
        ]
      );
    } else {
      await client.query(
        `INSERT INTO subscriptions
          (customer_id, plan_id, starts_on, expires_on, status, bitpanel_list_id)
         VALUES ($1, $2, CURRENT_DATE, $3, $4, $5)`,
        [
          request.params.id,
          plan.rows[0].id,
          body.expiresOn,
          body.status,
          body.bitpanelListId?.trim() || null
        ]
      );
    }
    return { before: before.rows[0], customer: customer.rows[0] };
  });
  if (!result) return reply.code(404).send({ error: 'Cliente não encontrado.' });
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: 'customer.updated',
    entityType: 'customer',
    entityId: request.params.id,
    before: result.before,
    after: { ...body, whatsapp: maskPhone(phone) },
    ip: request.ip
  });
  return { ok: true };
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
            plan: z.enum([
              'monthly', 'quarterly', 'semiannual', 'annual',
              'mensal', 'trimestral', 'semestral', 'anual'
            ]),
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
      const planCode = ({
        mensal: 'monthly',
        trimestral: 'quarterly',
        semestral: 'semiannual',
        anual: 'annual'
      })[item.plan] || item.plan;
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

app.post('/api/admin/customers/import-spreadsheet', { preHandler: requireAuth }, async (request) => {
  const upload = await request.file();
  if (!upload) throw Object.assign(new Error('Selecione uma planilha.'), { statusCode: 400 });
  if (!/\.(xlsx|xls)$/i.test(upload.filename || '')) {
    throw Object.assign(new Error('Envie um arquivo .xls ou .xlsx.'), { statusCode: 400 });
  }
  const customers = parseCustomerSpreadsheet(await upload.toBuffer());
  const result = await app.inject({
    method: 'POST',
    url: '/api/admin/customers/import',
    headers: { cookie: request.headers.cookie || '' },
    payload: { customers }
  });
  const response = result.json();
  if (result.statusCode >= 400) {
    throw Object.assign(new Error(response.error || response.message || 'Falha na importação.'), {
      statusCode: result.statusCode
    });
  }
  return { ...response, rows: customers.length };
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
    `UPDATE renewal_jobs r
        SET status = 'queued', approved_by = $2, approved_at = now(), error = NULL, updated_at = now()
       FROM charges ch
      WHERE r.id = $1
        AND ch.id = r.charge_id
        AND ch.status = 'paid'
        AND r.status IN ('awaiting_approval', 'manual_review', 'simulated')
      RETURNING r.id`,
    [request.params.id, request.user.id]
  );
  if (!result.rows[0]) {
    return reply.code(409).send({
      error: 'Renovação não pode ser executada sem pagamento confirmado.'
    });
  }
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
    'renewal_requires_approval',
    'ai_admin_enabled',
    'ai_whatsapp_enabled'
  ];
  const values = Object.fromEntries(
    await Promise.all(keys.map(async (key) => [key, await getSetting(db, key, null)]))
  );
  const status = await credentialStatus(db, config);
  const mercadoPago = getMercadoPagoReadiness(status.runtime);
  return {
    settings: values,
    integrations: {
      redis: Boolean(config.REDIS_URL),
      mercadoPago: mercadoPago.ready,
      whatsapp: status.configured.whatsapp,
      bitpanel: status.configured.bitpanel,
      openai: status.configured.openai
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
      renewal_requires_approval: z.boolean().optional(),
      ai_admin_enabled: z.boolean().optional(),
      ai_whatsapp_enabled: z.boolean().optional()
    }),
    request.body
  );
  const runtimeConfig = await getRuntimeConfig(db, config);
  const [currentPaymentMode, currentBitPanelMode] = await Promise.all([
    getSetting(db, 'payment_mode', config.PAYMENT_MODE),
    getSetting(db, 'bitpanel_mode', config.BITPANEL_MODE)
  ]);
  if (body.payment_mode === 'live' && !getMercadoPagoReadiness(runtimeConfig).ready) {
    const error = new Error(
      'Configure o Access Token de produção, o segredo e o webhook do Mercado Pago antes do modo real.'
    );
    error.statusCode = 409;
    throw error;
  }
  if (
    body.renewal_requires_approval === false &&
    (body.payment_mode || currentPaymentMode) !== 'live'
  ) {
    throw Object.assign(
      new Error('Ative o pagamento real antes da renovação automática.'),
      { statusCode: 409 }
    );
  }
  if (
    body.renewal_requires_approval === false &&
    (body.bitpanel_mode || currentBitPanelMode) !== 'live'
  ) {
    throw Object.assign(
      new Error('Ative o BitPanel real antes da renovação automática.'),
      { statusCode: 409 }
    );
  }
  if (
    body.renewal_requires_approval === false &&
    (!runtimeConfig.BITPANEL_USERNAME || !runtimeConfig.BITPANEL_PASSWORD)
  ) {
    throw Object.assign(
      new Error('Configure e teste o BitPanel antes da renovação automática.'),
      { statusCode: 409 }
    );
  }
  if ((body.ai_admin_enabled || body.ai_whatsapp_enabled) && !runtimeConfig.OPENAI_API_KEY) {
    throw Object.assign(
      new Error('Configure a chave da OpenAI antes de ativar a ajuda de IA.'),
      { statusCode: 409 }
    );
  }
  if (
    body.ai_whatsapp_enabled &&
    (!runtimeConfig.WHATSAPP_ACCESS_TOKEN || !runtimeConfig.WHATSAPP_PHONE_NUMBER_ID)
  ) {
    throw Object.assign(
      new Error('Configure o WhatsApp Cloud API antes de ativar a IA para clientes.'),
      { statusCode: 409 }
    );
  }
  if (
    body.whatsapp_mode === 'live' &&
    (!runtimeConfig.WHATSAPP_ACCESS_TOKEN ||
      !runtimeConfig.WHATSAPP_PHONE_NUMBER_ID ||
      !runtimeConfig.WHATSAPP_VERIFY_TOKEN ||
      !runtimeConfig.META_APP_SECRET)
  ) {
    const error = new Error('Configure tokens, número e assinatura da Meta antes do modo real.');
    error.statusCode = 409;
    throw error;
  }
  if (
    body.bitpanel_mode === 'live' &&
    (!runtimeConfig.BITPANEL_USERNAME || !runtimeConfig.BITPANEL_PASSWORD)
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

app.put('/api/admin/integrations/:provider', { preHandler: requireAuth }, async (request) => {
  const provider = parse(
    z.enum(['mercadopago', 'whatsapp', 'bitpanel', 'openai']),
    request.params.provider
  );
  const body = parse(z.record(z.string(), z.union([z.string(), z.number()])), request.body || {});
  await saveIntegrationCredentials(db, config, provider, body, request.user.id);
  await audit(db, {
    actorType: 'user',
    actorId: request.user.id,
    action: `integration.${provider}_configured`,
    entityType: 'integration',
    entityId: provider,
    after: sanitizeForLog(body),
    ip: request.ip
  });
  return { ok: true };
});

app.post('/api/admin/integrations/:provider/test', { preHandler: requireAuth }, async (request) => {
  const provider = parse(
    z.enum(['mercadopago', 'whatsapp', 'bitpanel', 'openai']),
    request.params.provider
  );
  const runtimeConfig = await getRuntimeConfig(db, config);
  if (provider === 'bitpanel') {
    try {
      return await testBitPanelConnection(runtimeConfig);
    } catch (error) {
      throw Object.assign(new Error(safeBitPanelSyncError(error)), { statusCode: 409 });
    }
  }
  if (provider === 'openai') return testOpenAIConnection(runtimeConfig);
  if (provider === 'mercadopago') {
    if (!getMercadoPagoReadiness(runtimeConfig).ready) {
      throw Object.assign(new Error('Complete as credenciais do Mercado Pago.'), { statusCode: 409 });
    }
    const response = await fetch('https://api.mercadopago.com/users/me', {
      headers: { Authorization: `Bearer ${runtimeConfig.MERCADOPAGO_ACCESS_TOKEN}` }
    });
    if (!response.ok) {
      throw Object.assign(new Error('Access Token recusado pelo Mercado Pago.'), { statusCode: 409 });
    }
    const paymentMode = await getSetting(db, 'payment_mode', config.PAYMENT_MODE);
    return {
      ok: true,
      paymentMode,
      message:
        paymentMode === 'live'
          ? 'Mercado Pago conectado e Checkout real ativo.'
          : 'Credenciais válidas, mas o Checkout ainda está em Simulação. Clique em “Ativar Checkout real”.'
    };
  }
  if (!runtimeConfig.WHATSAPP_PHONE_NUMBER_ID || !runtimeConfig.WHATSAPP_ACCESS_TOKEN) {
    throw Object.assign(new Error('Complete o token e o ID do número.'), { statusCode: 409 });
  }
  const response = await fetch(
    `https://graph.facebook.com/${runtimeConfig.WHATSAPP_GRAPH_VERSION}/${runtimeConfig.WHATSAPP_PHONE_NUMBER_ID}`,
    { headers: { Authorization: `Bearer ${runtimeConfig.WHATSAPP_ACCESS_TOKEN}` } }
  );
  if (!response.ok) {
    throw Object.assign(new Error('Credenciais recusadas pela Meta.'), { statusCode: 409 });
  }
  return { ok: true, message: 'WhatsApp Cloud API conectado.' };
});

app.get('/api/admin/ai/history', { preHandler: requireAuth }, async (request) => {
  const result = await db.query(
    `SELECT id, role, content, model, created_at
       FROM ai_messages
      WHERE audience = 'admin' AND actor_id = $1
      ORDER BY created_at DESC
      LIMIT 30`,
    [String(request.user.id)]
  );
  return { messages: result.rows.reverse() };
});

app.post(
  '/api/admin/ai/chat',
  {
    preHandler: requireAuth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  },
  async (request) => {
    const body = parse(
      z.object({ question: z.string().trim().min(2).max(2000) }),
      request.body
    );
    const enabled = await getSetting(db, 'ai_admin_enabled', config.AI_ADMIN_ENABLED);
    if (!enabled) {
      throw Object.assign(new Error('A IA do administrador está desativada.'), {
        statusCode: 409
      });
    }
    const runtimeConfig = await getRuntimeConfig(db, config);
    const answer = await answerAdminQuestion({
      db,
      config: runtimeConfig,
      user: request.user,
      question: body.question
    });
    await audit(db, {
      actorType: 'user',
      actorId: request.user.id,
      action: 'ai.admin_question_answered',
      entityType: 'ai_message',
      entityId: answer.id,
      ip: request.ip
    });
    return { answer: answer.text, model: answer.model };
  }
);

app.post(
  '/api/admin/integrations/mercadopago/activate',
  { preHandler: requireAuth },
  async (request) => {
    const runtimeConfig = await getRuntimeConfig(db, config);
    const readiness = getMercadoPagoReadiness(runtimeConfig);
    if (!readiness.ready) {
      throw Object.assign(
        new Error(`Mercado Pago incompleto: ${readiness.missing.join(', ')}.`),
        { statusCode: 409 }
      );
    }
    const response = await fetch('https://api.mercadopago.com/users/me', {
      headers: { Authorization: `Bearer ${runtimeConfig.MERCADOPAGO_ACCESS_TOKEN}` }
    });
    if (!response.ok) {
      throw Object.assign(new Error('Access Token recusado pelo Mercado Pago.'), {
        statusCode: 409
      });
    }
    await setSetting(db, 'payment_mode', 'live', request.user.id);
    await audit(db, {
      actorType: 'user',
      actorId: request.user.id,
      action: 'mercadopago.checkout_activated',
      entityType: 'system_settings',
      entityId: 'payment_mode',
      after: { payment_mode: 'live' },
      ip: request.ip
    });
    return { ok: true, paymentMode: 'live', message: 'Checkout real do Mercado Pago ativado.' };
  }
);

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
      'SELECT code, name, duration_months, price_cents, description FROM plans WHERE active = true ORDER BY sort_order'
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
      z.object({ planCode: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']) }),
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
    const runtimeConfig = {
      ...(await getRuntimeConfig(db, config)),
      PAYMENT_MODE: await getSetting(db, 'payment_mode', config.PAYMENT_MODE)
    };
    const chargeDetails = await db.query(
      `SELECT ch.id, ch.idempotency_key, ch.amount_cents,
              c.name AS customer_name, c.email AS customer_email,
              c.whatsapp_e164 AS customer_phone,
              p.code AS plan_code, p.name AS plan_name, p.duration_months
         FROM charges ch
         JOIN subscriptions s ON s.id = ch.subscription_id
         JOIN customers c ON c.id = s.customer_id
         JOIN plans p ON p.id = ch.plan_id
        WHERE ch.id = $1`,
      [created.id]
    );
    const preference = await createCheckoutPreference(runtimeConfig, chargeDetails.rows[0]);
    await db.query(
      `UPDATE charges SET mercado_pago_preference_id = $2, checkout_url = $3, updated_at = now()
        WHERE id = $1`,
      [created.id, preference.id, preference.checkoutUrl]
    );
    return reply.code(201).send({
      ok: true,
      status: created.status,
      queued,
      planName: created.planName,
      checkoutUrl: preference.checkoutUrl,
      message: `Plano ${created.planName} escolhido. Abrindo o pagamento seguro do Mercado Pago.`
    });
  }
);

app.get('/cliente/:token', async (_request, reply) => reply.sendFile('portal.html'));
app.get('/captacao', async (_request, reply) => reply.sendFile('landing.html'));
app.get('/pagamento', async (_request, reply) => reply.sendFile('payment.html'));
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
