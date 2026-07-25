import { Worker } from 'bullmq';
import { CronJob } from 'cron';
import { loadConfig } from './config.js';
import { createDb, getSetting } from './db.js';
import { initializeDatabase } from './init.js';
import { createRedis } from './queue.js';
import { scanBilling } from './services/billing.js';
import { createPixPayment } from './integrations/mercadopago.js';
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
  provisionInBitPanel,
  renewInBitPanel
} from './integrations/bitpanel.js';
import { audit } from './audit.js';
import { formatDate, formatMoney } from './domain/billing.js';
import { getRuntimeConfig } from './integrations/runtime-config.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
const redis = createRedis(config.REDIS_URL);

async function effectiveConfig() {
  const [paymentMode, whatsappMode, bitpanelMode, renewalApproval] = await Promise.all([
    getSetting(db, 'payment_mode', config.PAYMENT_MODE),
    getSetting(db, 'whatsapp_mode', config.WHATSAPP_MODE),
    getSetting(db, 'bitpanel_mode', config.BITPANEL_MODE),
    getSetting(db, 'renewal_requires_approval', config.RENEWAL_REQUIRES_APPROVAL)
  ]);
  return {
    ...(await getRuntimeConfig(db, config)),
    PAYMENT_MODE: paymentMode,
    WHATSAPP_MODE: whatsappMode,
    BITPANEL_MODE: bitpanelMode,
    RENEWAL_REQUIRES_APPROVAL: renewalApproval
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

  if (job.name === 'send-payment-confirmation') {
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
  charge = await ensurePix(runtimeConfig, charge);
  const enriched = {
    ...charge,
    amount_br: formatMoney(charge.amount_cents),
    due_on_br: formatDate(charge.due_on)
  };
  const response = job.data.conversationWindow
    ? await sendText(
        runtimeConfig,
        charge.whatsapp_e164,
        `${charge.message_text}\n\nPix copia e cola:\n${charge.pix_copy_paste}`
      )
    : await sendChargeTemplate(runtimeConfig, enriched);

  await db.transaction(async (client) => {
    await client.query(
      `INSERT INTO message_logs
        (customer_id, charge_id, direction, template_name, content, provider_id, status, simulated)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7)`,
      [
        charge.customer_id,
        charge.id,
        job.data.conversationWindow ? null : `stage:${charge.stage}`,
        charge.message_text,
        response.messages?.[0]?.id,
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
  return { providerId: response.messages?.[0]?.id, simulated: response.simulated };
}

async function processRenewal(job) {
  const runtimeConfig = await effectiveConfig();
  if (job.name !== 'execute-renewal') throw new Error(`Job de renovação desconhecido: ${job.name}`);
  const paused = await getSetting(db, 'global_pause', config.GLOBAL_PAUSE);
  if (paused) throw new Error('Automações pausadas pelo administrador.');
  const result = await db.query(
    `SELECT r.*, ch.stage AS charge_stage,
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
  if (!renewal.approved_at && runtimeConfig.RENEWAL_REQUIRES_APPROVAL) {
    throw new Error('Renovação não aprovada. Execução bloqueada.');
  }
  const operation = bitPanelOperationFor(renewal);
  if (
    operation === 'renew' &&
    (!renewal.automation_eligible || renewal.bitpanel_owner !== 'Gate One Pro Server')
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
                  bitpanel_reference = COALESCE($2, bitpanel_reference),
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
            operation
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
        const message =
          operation === 'provision'
            ? await sendAccessCreatedTemplate(
                runtimeConfig,
                renewal,
                outcome,
                renewedUntilBr
              )
            : await sendRenewedTemplate(runtimeConfig, renewal, renewedUntilBr);
        await db.query(
          `INSERT INTO message_logs
            (customer_id, charge_id, direction, template_name, content, provider_id, status, simulated)
           VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7)`,
          [
            renewal.customer_id,
            renewal.charge_id,
            operation === 'provision'
              ? runtimeConfig.WHATSAPP_TEMPLATE_ACCESS_CREATED
              : runtimeConfig.WHATSAPP_TEMPLATE_RENEWED,
            operation === 'provision'
              ? `Acesso criado até ${renewedUntil}`
              : `Renovação concluída até ${renewedUntil}`,
            message.messages?.[0]?.id,
            message.simulated ? 'simulated' : 'sent',
            message.simulated
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

  const scan = () =>
    scanBilling(db, { timezone: config.TIMEZONE })
      .then((stats) => console.log({ stats }, 'Varredura de vencimentos concluída'))
      .catch((error) => console.error({ error: error.message }, 'Varredura falhou'));
  const cron = new CronJob('0 9 * * *', scan, null, true, config.TIMEZONE);
  await scan();
  console.log('Worker Gate One Pro iniciado.');

  const shutdown = async () => {
    cron.stop();
    await Promise.all([messageWorker.close(), renewalWorker.close()]);
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
