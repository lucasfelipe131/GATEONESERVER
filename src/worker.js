import { Worker } from 'bullmq';
import { CronJob } from 'cron';
import { loadConfig } from './config.js';
import { createDb, getSetting } from './db.js';
import { initializeDatabase } from './init.js';
import { createQueues, createRedis } from './queue.js';
import { scanBilling } from './services/billing.js';
import { createCheckoutPreference, createPixPayment } from './integrations/mercadopago.js';
import {
  sendAccessCreatedTemplate,
  sendChargeTemplate,
  sendPaymentConfirmationTemplate,
  sendPlanMenu,
  sendRenewedTemplate,
  sendText
} from './integrations/whatsapp.js';
import {
  bitPanelOperationFor,
  buildBitPanelUsername,
  isGateOneOwner,
  provisionInBitPanel,
  renewInBitPanel
} from './integrations/bitpanel.js';
import { audit } from './audit.js';
import { formatDate, formatMoney } from './domain/billing.js';
import { getRuntimeConfig } from './integrations/runtime-config.js';
import { answerCustomerQuestion } from './services/ai-support.js';
import { syncTelegramContent } from './services/telegram-content.js';
import { encryptSecret } from './security.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
const redis = createRedis(config.REDIS_URL);
const queues = createQueues(redis);

async function effectiveConfig() {
  const [paymentMode, whatsappMode, bitpanelMode, renewalApproval, aiWhatsAppEnabled] =
    await Promise.all([
      getSetting(db, 'payment_mode', config.PAYMENT_MODE),
      getSetting(db, 'whatsapp_mode', config.WHATSAPP_MODE),
      getSetting(db, 'bitpanel_mode', config.BITPANEL_MODE),
      getSetting(db, 'renewal_requires_approval', config.RENEWAL_REQUIRES_APPROVAL),
      getSetting(db, 'ai_whatsapp_enabled', config.AI_WHATSAPP_ENABLED)
    ]);
  return {
    ...(await getRuntimeConfig(db, config)),
    PAYMENT_MODE: paymentMode,
    WHATSAPP_MODE: whatsappMode,
    BITPANEL_MODE: bitpanelMode,
    RENEWAL_REQUIRES_APPROVAL: renewalApproval,
    AI_WHATSAPP_ENABLED: aiWhatsAppEnabled
  };
}

async function sendQrNotice(runtimeConfig, to, text) {
  if (!runtimeConfig.GATE_ONE_WHATSAPP_QR_URL || !runtimeConfig.GATE_ONE_WHATSAPP_NOTIFY_SECRET) {
    return null;
  }
  const response = await fetch(
    `${runtimeConfig.GATE_ONE_WHATSAPP_QR_URL.replace(/\/$/, '')}/api/gate-one/notify`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gate-One-Notify-Secret': runtimeConfig.GATE_ONE_WHATSAPP_NOTIFY_SECRET
      },
      body: JSON.stringify({ to, text })
    }
  );
  if (!response.ok) {
    throw new Error(`WhatsApp QR recusou a confirmação da renovação (${response.status}).`);
  }
  return { channel: 'whatsapp_qr', providerId: null, simulated: false, content: text };
}

async function deliverRenewalResult(runtimeConfig, renewal, outcome, operation, renewedUntilBr) {
  const content = operation === 'provision'
    ? [
        `✅ Olá, ${String(renewal.customer_name || 'cliente').split(/\s+/)[0]}! Seu acesso Gate One Pro foi criado.`,
        `Plano: ${renewal.plan_name}.`,
        `Login: ${outcome.username || renewal.bitpanel_reference || 'em atualização'}`,
        `Senha: ${outcome.password || 'em atualização'}`,
        `Validade: ${renewedUntilBr}.`,
        'Guarde esses dados e não os compartilhe.'
      ].join('\n')
    : [
        `✅ Olá, ${String(renewal.customer_name || 'cliente').split(/\s+/)[0]}! Sua renovação foi concluída.`,
        `Plano: ${renewal.plan_name}.`,
        `Nova validade: ${renewedUntilBr}.`
      ].join('\n');

  try {
    const qr = await sendQrNotice(runtimeConfig, renewal.whatsapp_e164, content);
    if (qr) return qr;
  } catch (error) {
    if (!runtimeConfig.WHATSAPP_ACCESS_TOKEN || !runtimeConfig.WHATSAPP_PHONE_NUMBER_ID) {
      throw error;
    }
  }

  const message = operation === 'provision'
    ? await sendAccessCreatedTemplate(runtimeConfig, renewal, outcome, renewedUntilBr)
    : await sendRenewedTemplate(runtimeConfig, renewal, renewedUntilBr);
  return {
    channel: 'whatsapp',
    providerId: message.messages?.[0]?.id || null,
    simulated: Boolean(message.simulated),
    content
  };
}

async function loadCharge(chargeId) {
  const result = await db.query(
    `SELECT ch.*, ch.due_on::text,
            c.id AS customer_id, c.name AS customer_name, c.email AS customer_email,
            c.whatsapp_e164, c.opt_out_at,
            p.name AS plan_name, p.code AS plan_code, p.duration_months
       FROM charges ch
       JOIN subscriptions s ON s.id = ch.subscription_id
       JOIN customers c ON c.id = s.customer_id
       JOIN plans p ON p.id = COALESCE(ch.plan_id, s.plan_id)
      WHERE ch.id = $1`,
    [chargeId]
  );
  if (!result.rows[0]) throw new Error('Cobrança não encontrada.');
  return result.rows[0];
}

async function ensurePix(runtimeConfig, charge) {
  if (charge.pix_copy_paste && charge.pix_expires_at > new Date()) return charge;
  const payment = await createPixPayment(runtimeConfig, charge);
  const result = await db.query(
    `UPDATE charges
        SET mercado_pago_payment_id = $2,
            pix_copy_paste = $3,
            pix_ticket_url = $4,
            pix_expires_at = $5,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [charge.id, payment.id, payment.qrCode, payment.ticketUrl, payment.expiration]
  );
  return { ...charge, ...result.rows[0] };
}

async function ensureCheckout(runtimeConfig, charge) {
  if (charge.checkout_url) return charge;
  const preference = await createCheckoutPreference(runtimeConfig, {
    id: charge.id,
    idempotency_key: `${charge.idempotency_key}:checkout`,
    customer_name: charge.customer_name,
    customer_email: charge.customer_email,
    customer_phone: charge.whatsapp_e164,
    plan_code: charge.plan_code,
    plan_name: charge.plan_name,
    duration_months: charge.duration_months,
    amount_cents: charge.amount_cents
  });
  const result = await db.query(
    `UPDATE charges
        SET mercado_pago_preference_id = $2, checkout_url = $3, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [charge.id, preference.id, preference.checkoutUrl]
  );
  return { ...charge, ...result.rows[0] };
}

async function processMessage(job) {
  const runtimeConfig = await effectiveConfig();
  const paused = await getSetting(db, 'global_pause', config.GLOBAL_PAUSE);
  if (paused) throw new Error('Automações pausadas pelo administrador.');

  if (job.name === 'send-free-text') {
    const response = await sendText(runtimeConfig, job.data.to, job.data.text);
    await db.query(
      `INSERT INTO message_logs
        (customer_id, direction, content, provider_id, status, simulated)
       VALUES ($1, 'outbound', $2, $3, $4, $5)`,
      [
        job.data.customerId,
        job.data.text,
        response.messages?.[0]?.id,
        response.simulated ? 'simulated' : 'sent',
        response.simulated
      ]
    );
    return response;
  }

  if (job.name === 'send-plan-menu') {
    const response = await sendPlanMenu(runtimeConfig, job.data.to);
    await db.query(
      `INSERT INTO message_logs
        (customer_id, direction, content, provider_id, status, simulated)
       VALUES ($1, 'outbound', 'Menu de planos', $2, $3, $4)`,
      [
        job.data.customerId,
        response.messages?.[0]?.id,
        response.simulated ? 'simulated' : 'sent',
        response.simulated
      ]
    );
    return response;
  }

  if (job.name === 'send-ai-reply') {
    if (!runtimeConfig.AI_WHATSAPP_ENABLED) {
      throw new Error('IA do WhatsApp desativada pelo administrador.');
    }
    let text;
    try {
      const answer = await answerCustomerQuestion({
        db,
        config: runtimeConfig,
        customerId: job.data.customerId,
        question: job.data.question
      });
      text = answer.text;
    } catch (error) {
      text =
        'Não consegui consultar a ajuda automática agora. Digite ATENDENTE para falar com o suporte.';
      await audit(db, {
        action: 'ai.customer_answer_failed',
        entityType: 'customer',
        entityId: job.data.customerId,
        after: { error: error.message }
      });
    }
    const response = await sendText(runtimeConfig, job.data.to, text);
    await db.query(
      `INSERT INTO message_logs
        (customer_id, direction, content, provider_id, status, simulated)
       VALUES ($1, 'outbound', $2, $3, $4, $5)`,
      [
        job.data.customerId,
        text,
        response.messages?.[0]?.id,
        response.simulated ? 'simulated' : 'sent',
        response.simulated
      ]
    );
    return response;
  }

  if (job.name === 'send-payment-confirmation') {
    if (
      runtimeConfig.GATE_ONE_WHATSAPP_QR_URL &&
      runtimeConfig.GATE_ONE_WHATSAPP_NOTIFY_SECRET &&
      (!runtimeConfig.WHATSAPP_ACCESS_TOKEN || !runtimeConfig.WHATSAPP_PHONE_NUMBER_ID)
    ) {
      return { skipped: true, reason: 'qr_confirmation_sent_by_webhook' };
    }
    const charge = await loadCharge(job.data.chargeId);
    const response = await sendPaymentConfirmationTemplate(runtimeConfig, charge);
    await db.query(
      `INSERT INTO message_logs
        (customer_id, charge_id, direction, template_name, content, provider_id, status, simulated)
       VALUES ($1, $2, 'outbound', $3, 'Pagamento confirmado', $4, $5, $6)`,
      [
        charge.customer_id,
        charge.id,
        runtimeConfig.WHATSAPP_TEMPLATE_PAYMENT_CONFIRMED,
        response.messages?.[0]?.id,
        response.simulated ? 'simulated' : 'sent',
        response.simulated
      ]
    );
    return response;
  }

  if (job.name !== 'send-charge') throw new Error(`Job de mensagem desconhecido: ${job.name}`);
  let charge = await loadCharge(job.data.chargeId);
  if (!charge.approved_at && charge.status !== 'approved') {
    throw new Error('Cobrança não aprovada. Envio bloqueado.');
  }
  if (charge.opt_out_at) throw new Error('Cliente solicitou saída das mensagens.');
  const qrDelivery = Boolean(
    runtimeConfig.GATE_ONE_WHATSAPP_QR_URL &&
      runtimeConfig.GATE_ONE_WHATSAPP_NOTIFY_SECRET
  );
  charge = qrDelivery
    ? await ensureCheckout(runtimeConfig, charge)
    : await ensurePix(runtimeConfig, charge);
  const enriched = {
    ...charge,
    amount_br: formatMoney(charge.amount_cents),
    due_on_br: formatDate(charge.due_on)
  };
  const qrText = `${charge.message_text}\n\nPague pelo link seguro:\n${charge.checkout_url}`;
  const response = qrDelivery
    ? await sendQrNotice(runtimeConfig, charge.whatsapp_e164, qrText)
    : job.data.conversationWindow
      ? await sendText(
          runtimeConfig,
          charge.whatsapp_e164,
          `${charge.message_text}\n\nPix copia e cola:\n${charge.pix_copy_paste}`
        )
      : await sendChargeTemplate(runtimeConfig, enriched);
  const providerId = qrDelivery ? response.providerId : response.messages?.[0]?.id;

  await db.transaction(async (client) => {
    await client.query(
      `INSERT INTO message_logs
        (customer_id, charge_id, direction, channel, template_name, content, provider_id, status, simulated)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8)`,
      [
        charge.customer_id,
        charge.id,
        qrDelivery ? 'whatsapp_qr' : 'whatsapp',
        qrDelivery || job.data.conversationWindow ? null : `stage:${charge.stage}`,
        qrDelivery ? qrText : charge.message_text,
        providerId,
        response.simulated ? 'simulated' : 'sent',
        response.simulated
      ]
    );
    if (!response.simulated) {
      await client.query(
        "UPDATE charges SET status = 'sent', updated_at = now() WHERE id = $1",
        [charge.id]
      );
    }
  });
  return { providerId, simulated: response.simulated };
}

async function processRenewal(job) {
  const runtimeConfig = await effectiveConfig();
  if (job.name !== 'execute-renewal') throw new Error(`Job de renovação desconhecido: ${job.name}`);
  const paused = await getSetting(db, 'global_pause', config.GLOBAL_PAUSE);
  if (paused) throw new Error('Automações pausadas pelo administrador.');
  const result = await db.query(
    `SELECT r.*, ch.stage AS charge_stage, ch.status AS charge_status,
            s.expires_on::text AS current_expiry, s.bitpanel_list_id,
            c.name AS customer_name, c.bitpanel_reference, c.id AS customer_id,
            c.whatsapp_e164, c.bitpanel_owner, c.automation_eligible,
            p.code AS plan_code, p.name AS plan_name, p.duration_months
       FROM renewal_jobs r
       JOIN charges ch ON ch.id = r.charge_id
       JOIN subscriptions s ON s.id = ch.subscription_id
       JOIN customers c ON c.id = s.customer_id
       JOIN plans p ON p.id = COALESCE(ch.plan_id, s.plan_id)
      WHERE r.id = $1`,
    [job.data.renewalId]
  );
  const renewal = result.rows[0];
  if (!renewal) throw new Error('Renovação não encontrada.');
  if (renewal.charge_status !== 'paid') {
    throw new Error('Pagamento não confirmado. Renovação bloqueada.');
  }
  if (!renewal.approved_at && runtimeConfig.RENEWAL_REQUIRES_APPROVAL) {
    throw new Error('Renovação não aprovada. Execução bloqueada.');
  }
  const operation = bitPanelOperationFor(renewal);
  if (
    operation === 'renew' &&
    (!renewal.automation_eligible || !isGateOneOwner(renewal.bitpanel_owner))
  ) {
    throw new Error('Automação bloqueada: o cliente não pertence ao Gate One Pro Server.');
  }
  if (operation === 'provision' && !renewal.bitpanel_reference) {
    renewal.bitpanel_reference = buildBitPanelUsername(
      renewal.customer_name,
      renewal.customer_id
    );
    await db.query(
      `UPDATE customers SET bitpanel_reference = $2, updated_at = now() WHERE id = $1`,
      [renewal.customer_id, renewal.bitpanel_reference]
    );
  }

  await db.query(
    `UPDATE renewal_jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = $1`,
    [renewal.id]
  );
  try {
    const outcome =
      operation === 'provision'
        ? await provisionInBitPanel(runtimeConfig, renewal)
        : await renewInBitPanel(runtimeConfig, renewal);
    const renewedUntil = await db.transaction(async (client) => {
      const encryptedAccessPassword = outcome.password
        ? encryptSecret(outcome.password, config.COOKIE_SECRET)
        : null;
      await client.query(
        `UPDATE renewal_jobs
            SET status = $2, before_expiry = $3, after_expiry = $4,
                evidence_path = $5, error = NULL, updated_at = now()
          WHERE id = $1`,
        [
          renewal.id,
          outcome.simulated ? 'simulated' : 'completed',
          outcome.beforeExpiry,
          outcome.afterExpiry,
          outcome.evidencePath
        ]
      );
      if (!outcome.simulated) {
        const subscription = await client.query(
          `UPDATE subscriptions
              SET plan_id = COALESCE(
                    (SELECT plan_id FROM charges WHERE id = $1),
                    plan_id
                  ),
                  expires_on = COALESCE(
                    $3::date,
                    (GREATEST(expires_on, CURRENT_DATE)
                     + make_interval(months => $2))::date
                  ),
                  bitpanel_list_id = COALESCE($4, bitpanel_list_id),
                  status = 'active',
                  updated_at = now()
            WHERE id = (SELECT subscription_id FROM charges WHERE id = $1)
            RETURNING expires_on::text`,
          [
            renewal.charge_id,
            renewal.duration_months,
            outcome.afterExpiry,
            outcome.listId || null
          ]
        );
        await client.query(
          `UPDATE customers
          SET status = 'active',
                  operational_stage = 'ready',
                  bitpanel_reference = COALESCE($2, bitpanel_reference),
                  access_password_encrypted = COALESCE($4, access_password_encrypted),
                  bitpanel_owner = CASE
                    WHEN $3 = 'provision' THEN 'Gate One Pro Server'
                    ELSE bitpanel_owner
                  END,
                  automation_eligible = CASE
                    WHEN $3 = 'provision' THEN true
                    ELSE automation_eligible
                  END,
                  updated_at = now()
            WHERE id = $1`,
          [
            renewal.customer_id,
            outcome.username || renewal.bitpanel_reference,
            operation,
            encryptedAccessPassword
          ]
        );
        await client.query(
          `INSERT INTO loyalty_ledger
            (customer_id, points, reason, reference_type, reference_id)
           VALUES ($1, $2, $3, 'charge', $4)`,
          [
            renewal.customer_id,
            renewal.duration_months === 3 ? 30 : 10,
            operation === 'provision' ? 'Nova assinatura paga' : 'Renovação paga',
            renewal.charge_id
          ]
        );
        return subscription.rows[0]?.expires_on || outcome.afterExpiry;
      }
      return null;
    });
    await audit(db, {
      action: outcome.simulated
        ? `bitpanel.${operation}_simulated`
        : `bitpanel.${operation}_completed`,
      entityType: 'renewal_job',
      entityId: renewal.id,
      after: {
        operation,
        listId: outcome.listId || renewal.bitpanel_list_id || null,
        username: outcome.username || renewal.bitpanel_reference || null,
        beforeExpiry: outcome.beforeExpiry,
        afterExpiry: outcome.afterExpiry,
        evidencePath: outcome.evidencePath
      }
    });
    if (!outcome.simulated && renewedUntil) {
      try {
        const renewedUntilBr = renewedUntil.split('-').reverse().join('/');
        const delivery = await deliverRenewalResult(
          runtimeConfig,
          renewal,
          outcome,
          operation,
          renewedUntilBr
        );
        await db.query(
          `INSERT INTO message_logs
            (customer_id, charge_id, direction, channel, template_name, content, provider_id, status, simulated)
           VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8)`,
          [
            renewal.customer_id,
            renewal.charge_id,
            delivery.channel,
            delivery.channel === 'whatsapp' && operation === 'provision'
              ? runtimeConfig.WHATSAPP_TEMPLATE_ACCESS_CREATED
              : delivery.channel === 'whatsapp'
                ? runtimeConfig.WHATSAPP_TEMPLATE_RENEWED
                : null,
            delivery.content,
            delivery.providerId,
            delivery.simulated ? 'simulated' : 'sent',
            delivery.simulated
          ]
        );
      } catch (messageError) {
        await audit(db, {
          action:
            operation === 'provision'
              ? 'whatsapp.access_delivery_failed'
              : 'whatsapp.renewal_confirmation_failed',
          entityType: 'renewal_job',
          entityId: renewal.id,
          after: { error: messageError.message }
        });
      }
    }
    return outcome;
  } catch (error) {
    await db.query(
      `UPDATE renewal_jobs SET status = 'manual_review', error = $2, updated_at = now()
        WHERE id = $1`,
      [renewal.id, error.message]
    );
    await audit(db, {
      action: `bitpanel.${operation}_failed`,
      entityType: 'renewal_job',
      entityId: renewal.id,
      after: { error: error.message }
    });
    throw error;
  }
}

async function recoverAutomaticRenewals() {
  const runtimeConfig = await effectiveConfig();
  const paused = await getSetting(db, 'global_pause', config.GLOBAL_PAUSE);
  if (
    paused ||
    runtimeConfig.RENEWAL_REQUIRES_APPROVAL ||
    runtimeConfig.BITPANEL_MODE !== 'live'
  ) {
    return { recovered: 0, skipped: true };
  }
  const pending = await db.query(
    `SELECT r.id, ch.stage, s.bitpanel_list_id,
            c.automation_eligible, c.bitpanel_owner
       FROM renewal_jobs r
       JOIN charges ch ON ch.id = r.charge_id
       JOIN subscriptions s ON s.id = ch.subscription_id
       JOIN customers c ON c.id = s.customer_id
      WHERE r.status IN ('awaiting_approval', 'manual_review')
        AND ch.status = 'paid'
      ORDER BY r.created_at
      LIMIT 100`
  );
  let recovered = 0;
  for (const item of pending.rows) {
    const provision = item.stage === 'new_sale' || !item.bitpanel_list_id;
    if (!provision && (!item.automation_eligible || !isGateOneOwner(item.bitpanel_owner))) {
      continue;
    }
    const updated = await db.query(
      `UPDATE renewal_jobs
          SET status = 'queued', approved_at = COALESCE(approved_at, now()),
              error = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('awaiting_approval', 'manual_review')
        RETURNING id`,
      [item.id]
    );
    if (!updated.rows[0]) continue;
    try {
      await queues.renewals.add(
        'execute-renewal',
        { renewalId: item.id },
        {
          jobId: `renewal-recovery-${item.id}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: 1000,
          removeOnFail: 2000
        }
      );
    } catch (error) {
      await db.query(
        `UPDATE renewal_jobs SET status = 'awaiting_approval', updated_at = now()
          WHERE id = $1 AND status = 'queued'`,
        [item.id]
      );
      throw error;
    }
    recovered += 1;
    await audit(db, {
      actorType: 'system',
      action: 'bitpanel.automatic_job_recovered',
      entityType: 'renewal_job',
      entityId: item.id
    });
  }
  return { recovered, skipped: false };
}

async function queueAutomaticCharge(chargeId) {
  await queues.messages.add(
    'send-charge',
    { chargeId },
    {
      jobId: `charge-auto-${chargeId}`,
      attempts: 20,
      backoff: { type: 'fixed', delay: 300_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000
    }
  );
}

async function recoverAutomaticCharges() {
  const [salesMode, paymentMode, paused] = await Promise.all([
    getSetting(db, 'sales_mode', config.SALES_MODE),
    getSetting(db, 'payment_mode', config.PAYMENT_MODE),
    getSetting(db, 'global_pause', config.GLOBAL_PAUSE)
  ]);
  if (salesMode !== 'automatic' || paymentMode !== 'live' || paused) {
    return { recovered: 0, skipped: true };
  }
  const result = await db.query(
    `SELECT ch.id
       FROM charges ch
       JOIN subscriptions s ON s.id = ch.subscription_id
       JOIN customers c ON c.id = s.customer_id
      WHERE ch.status = 'approved'
        AND ch.approved_at IS NULL
        AND c.consent_contact = true
        AND c.opt_out_at IS NULL
      ORDER BY ch.created_at
      LIMIT 100`
  );
  for (const charge of result.rows) await queueAutomaticCharge(charge.id);
  return { recovered: result.rowCount, skipped: false };
}

async function start() {
  await initializeDatabase(db, config);
  const messageWorker = new Worker('gate-one-messages', processMessage, {
    connection: redis,
    concurrency: 5
  });
  const renewalWorker = new Worker('gate-one-renewals', processRenewal, {
    connection: redis,
    concurrency: 1
  });
  for (const worker of [messageWorker, renewalWorker]) {
    worker.on('failed', (job, error) => {
      console.error({ jobId: job?.id, queue: worker.name, error: error.message }, 'Job falhou');
    });
  }

  const scan = async () => {
    try {
      const [salesMode, paymentMode, paused] = await Promise.all([
        getSetting(db, 'sales_mode', config.SALES_MODE),
        getSetting(db, 'payment_mode', config.PAYMENT_MODE),
        getSetting(db, 'global_pause', config.GLOBAL_PAUSE)
      ]);
      const automatic = salesMode === 'automatic' && paymentMode === 'live' && !paused;
      const stats = await scanBilling(db, {
        timezone: config.TIMEZONE,
        initialStatus: automatic ? 'approved' : 'awaiting_approval'
      });
      if (automatic) {
        for (const chargeId of stats.chargeIds) await queueAutomaticCharge(chargeId);
      }
      console.log({ stats, automatic }, 'Varredura de vencimentos concluída');
      return stats;
    } catch (error) {
      console.error({ error: error.message }, 'Varredura falhou');
      return { checked: 0, created: 0, skipped: 0, chargeIds: [], error: error.message };
    }
  };
  const cron = new CronJob('0 9 * * *', scan, null, true, config.TIMEZONE);
  const syncContent = () => {
    if (!config.TELEGRAM_SYNC_ENABLED) return Promise.resolve({ skipped: true });
    return syncTelegramContent(db, { sourceUrl: config.TELEGRAM_CONTENT_URL })
      .then((stats) => console.log({ stats }, 'Conteúdos do Telegram sincronizados'))
      .catch((error) =>
        console.error({ error: error.message }, 'Falha na atualização de conteúdos do Telegram')
      );
  };
  const contentCron = new CronJob('30 8 * * *', syncContent, null, true, config.TIMEZONE);
  const recoveryCron = new CronJob(
    '*/5 * * * *',
    () => Promise.all([recoverAutomaticRenewals(), recoverAutomaticCharges()]).catch((error) =>
      console.error({ error: error.message }, 'Recuperação de automações falhou')
    ),
    null,
    true,
    config.TIMEZONE
  );
  await scan();
  await syncContent();
  await Promise.all([recoverAutomaticRenewals(), recoverAutomaticCharges()]);
  console.log('Worker Gate One Pro iniciado.');

  const shutdown = async () => {
    cron.stop();
    contentCron.stop();
    recoveryCron.stop();
    await Promise.all([messageWorker.close(), renewalWorker.close()]);
    await Promise.all([queues.messages.close(), queues.renewals.close()]);
    await redis.quit();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(async (error) => {
  console.error(error);
  await db.close();
  process.exit(1);
});
