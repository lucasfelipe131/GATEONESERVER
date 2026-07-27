import { normalizePhone } from '../security.js';
import { buildIdempotencyKey, renderChargeMessage } from '../domain/billing.js';
import { audit } from '../audit.js';
import { getSetting } from '../db.js';
import { requestsHumanSupport } from './ai-support.js';

function detectPlan(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (normalized === 'plan_monthly' || /\b(mensal|30)\b/.test(normalized)) return 'monthly';
  if (normalized === 'plan_quarterly' || /\b(trimestral|85|3 meses)\b/.test(normalized)) {
    return 'quarterly';
  }
  if (normalized === 'plan_semiannual' || /\b(semestral|150|6 meses)\b/.test(normalized)) return 'semiannual';
  if (normalized === 'plan_annual' || /\b(anual|270|12 meses)\b/.test(normalized)) return 'annual';
  return null;
}

function isOptOut(text) {
  return /^(sair|parar|stop|cancelar mensagens)$/i.test(String(text || '').trim());
}

function normalizeMessage(text) {
  return String(text || '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function wantsMenu(text) {
  return /^(menu|oi|ola|bom dia|boa tarde|boa noite|inicio|começar|comecar)$/.test(normalizeMessage(text));
}

function wantsAccountStatus(text) {
  return /\b(minha conta|meu plano|minha assinatura|vencimento|vence|validade|situacao|situação|status|renovar|renovacao|renovação|pix|pagamento|pagar)\b/.test(
    normalizeMessage(text)
  );
}

async function saveSession(db, phone, state, data = {}) {
  await db.query(
    `INSERT INTO conversation_sessions (whatsapp_e164, state, data, expires_at)
     VALUES ($1, $2, $3::jsonb, now() + interval '24 hours')
     ON CONFLICT (whatsapp_e164) DO UPDATE
       SET state = EXCLUDED.state, data = EXCLUDED.data,
           expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [phone, state, JSON.stringify(data)]
  );
}

async function accountSummary(db, customer) {
  const result = await db.query(
    `SELECT p.name AS plan_name, s.expires_on::text AS expires_on, s.status AS subscription_status,
            ch.status AS charge_status, ch.amount_cents, ch.checkout_url, ch.pix_copy_paste
       FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
       LEFT JOIN LATERAL (
         SELECT status, amount_cents, checkout_url, pix_copy_paste
           FROM charges
          WHERE subscription_id = s.id
          ORDER BY created_at DESC
          LIMIT 1
       ) ch ON true
      WHERE s.customer_id = $1
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [customer.id]
  );
  return result.rows[0] || null;
}

function formatAccountSummary(customer, account) {
  if (!account) {
    return `Olá, ${customer.name.split(/\s+/)[0]}! Ainda não encontramos um plano ativo neste número. Vou te mostrar as opções disponíveis.`;
  }
  const due = account.expires_on
    ? new Date(`${account.expires_on}T12:00:00`).toLocaleDateString('pt-BR')
    : 'em atualização';
  const amount = account.amount_cents
    ? (account.amount_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : null;
  const payment = {
    paid: 'Pagamento confirmado.',
    pending: 'Pagamento ainda está pendente.',
    approved: 'Cobrança em preparação.',
    sent: 'Cobrança enviada.',
    awaiting_approval: 'Cobrança aguardando validação.',
    failed: 'Houve uma falha na cobrança; um atendente pode ajudar.'
  }[account.charge_status] || '';
  return [
    `Olá, ${customer.name.split(/\s+/)[0]}! Aqui está sua conta:`,
    `• Plano: ${account.plan_name || 'em definição'}`,
    `• Validade: ${due}`,
    payment && `• ${payment}${amount ? ` Valor: ${amount}` : ''}`,
    account.checkout_url && account.charge_status !== 'paid' ? `• Pagar com segurança: ${account.checkout_url}` : '',
    'Se precisar, responda *MENU* para ver os planos ou *ATENDENTE* para falar com a equipe.'
  ]
    .filter(Boolean)
    .join('\n');
}

export async function handleInboundMessage({ db, queues, config, inbound }) {
  const phone = normalizePhone(inbound.from);
  const customerResult = await db.query(
    `INSERT INTO customers (name, whatsapp_e164, source, status, consent_contact)
     VALUES ($1, $2, 'whatsapp', 'lead', true)
     ON CONFLICT (whatsapp_e164) DO UPDATE
       SET name = CASE WHEN customers.name = 'Cliente' THEN EXCLUDED.name ELSE customers.name END,
           consent_contact = true,
           opt_out_at = NULL,
           updated_at = now()
     RETURNING *`,
    [inbound.name || 'Cliente', phone]
  );
  const customer = customerResult.rows[0];

  await db.query(
    `INSERT INTO message_logs
      (customer_id, direction, content, provider_id, status)
     VALUES ($1, 'inbound', $2, $3, 'received')`,
    [customer.id, inbound.text, inbound.id]
  );

  if (isOptOut(inbound.text)) {
    await db.query(
      `UPDATE customers SET consent_contact = false, opt_out_at = now(), updated_at = now()
        WHERE id = $1`,
      [customer.id]
    );
    await queues.messages.add(
      'send-free-text',
      { customerId: customer.id, to: phone, text: 'Tudo certo. Você não receberá novos avisos.' },
      { jobId: `optout-${inbound.id}` }
    );
    return { action: 'opt_out' };
  }

  if (wantsAccountStatus(inbound.text)) {
    const account = await accountSummary(db, customer);
    await saveSession(db, phone, 'account_summary', { customerId: customer.id });
    await queues.messages.add(
      'send-free-text',
      { customerId: customer.id, to: phone, text: formatAccountSummary(customer, account) },
      { jobId: `account-${inbound.id}` }
    );
    return { action: 'account_summary' };
  }

  if (wantsMenu(inbound.text)) {
    await saveSession(db, phone, 'menu', { customerId: customer.id });
    await queues.messages.add(
      'send-free-text',
      {
        customerId: customer.id,
        to: phone,
        text: `Olá, ${customer.name.split(/\s+/)[0]}! 👋\n\nPosso te ajudar com:\n• *PLANOS* — ver opções\n• *MINHA CONTA* — plano, validade e pagamento\n• *ATENDENTE* — falar com a equipe\n• *SAIR* — parar avisos\n\nOu toque em “Ver planos” abaixo.`
      },
      { jobId: `welcome-${inbound.id}` }
    );
    await queues.messages.add('send-plan-menu', { customerId: customer.id, to: phone }, { jobId: `menu-${inbound.id}` });
    return { action: 'menu' };
  }

  const planCode = detectPlan(inbound.text);
  if (!planCode) {
    await db.query(
      `INSERT INTO leads (name, whatsapp_e164, source, status)
       SELECT $1, $2, 'whatsapp', 'engaged'
       WHERE NOT EXISTS (
         SELECT 1 FROM leads WHERE whatsapp_e164 = $2 AND status IN ('new', 'engaged', 'payment_pending')
      )`,
      [customer.name, phone]
    );
    if (requestsHumanSupport(inbound.text)) {
      await db.query(
        `UPDATE leads
            SET notes = concat_ws(E'\n', NULLIF(notes, ''), 'Cliente solicitou atendimento humano.'),
                status = 'engaged', updated_at = now()
          WHERE whatsapp_e164 = $1 AND status IN ('new', 'engaged', 'payment_pending')`,
        [phone]
      );
      await queues.messages.add(
        'send-free-text',
        {
          customerId: customer.id,
          to: phone,
          text:
            'Certo! Registrei seu pedido de atendimento humano. Enquanto isso, envie uma mensagem para o suporte no WhatsApp +55 55 99611-1943.'
        },
        { jobId: `handoff-${inbound.id}` }
      );
      return { action: 'human_handoff' };
    }
    const aiEnabled = await getSetting(db, 'ai_whatsapp_enabled', config.AI_WHATSAPP_ENABLED);
    if (aiEnabled && config.OPENAI_API_KEY && String(inbound.text || '').trim()) {
      await queues.messages.add(
        'send-ai-reply',
        {
          customerId: customer.id,
          to: phone,
          question: String(inbound.text).trim()
        },
        {
          jobId: `ai-${inbound.id}`,
          attempts: 2,
          backoff: { type: 'fixed', delay: 15_000 },
          removeOnComplete: 1000,
          removeOnFail: 2000
        }
      );
      await audit(db, {
        actorType: 'whatsapp',
        actorId: phone,
        action: 'ai.customer_question_queued',
        entityType: 'customer',
        entityId: customer.id
      });
      return { action: 'ai_queued' };
    }
    await queues.messages.add(
      'send-plan-menu',
      { customerId: customer.id, to: phone },
      { jobId: `menu-${inbound.id}` }
    );
    await saveSession(db, phone, 'menu', { customerId: customer.id });
    return { action: 'menu' };
  }

  const planResult = await db.query('SELECT * FROM plans WHERE code = $1 AND active = true', [
    planCode
  ]);
  const plan = planResult.rows[0];
  if (!plan) throw new Error(`Plano ${planCode} indisponível.`);

  const salesMode = await getSetting(db, 'sales_mode', config.SALES_MODE);
  const paused = await getSetting(db, 'global_pause', config.GLOBAL_PAUSE);
  const initialStatus = salesMode === 'automatic' && !paused ? 'approved' : 'awaiting_approval';

  const result = await db.transaction(async (client) => {
    const existingCharge = await client.query(
      `SELECT ch.id, ch.status
         FROM charges ch
         JOIN subscriptions s ON s.id = ch.subscription_id
        WHERE s.customer_id = $1
          AND COALESCE(ch.plan_id, s.plan_id) = $2
          AND ch.stage = 'new_sale'
          AND ch.status IN ('awaiting_approval', 'approved', 'sent')
          AND ch.created_at > now() - interval '2 hours'
        ORDER BY ch.created_at DESC
        LIMIT 1`,
      [customer.id, plan.id]
    );
    if (existingCharge.rows[0]) {
      if (initialStatus === 'approved' && existingCharge.rows[0].status === 'awaiting_approval') {
        await client.query(
          `UPDATE charges
              SET status = 'approved', approved_at = now(), updated_at = now()
            WHERE id = $1`,
          [existingCharge.rows[0].id]
        );
      }
      return { chargeId: existingCharge.rows[0].id, duplicate: true };
    }
    const subscriptionResult = await client.query(
      `INSERT INTO subscriptions (customer_id, plan_id, starts_on, expires_on, status)
       VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, 'pending')
       RETURNING id, expires_on::text`,
      [customer.id, plan.id]
    );
    const subscription = subscriptionResult.rows[0];
    const chargeResult = await client.query(
      `INSERT INTO charges
        (subscription_id, stage, status, amount_cents, due_on, idempotency_key, message_text)
       VALUES ($1, 'new_sale', $2, $3, CURRENT_DATE, $4, $5)
       RETURNING id`,
      [
        subscription.id,
        initialStatus,
        plan.price_cents,
        buildIdempotencyKey(subscription.id, 'new_sale', subscription.expires_on),
        renderChargeMessage({
          name: customer.name,
          planName: plan.name,
          expiresOn: subscription.expires_on,
          amountCents: plan.price_cents,
          stage: 'new_sale'
        })
      ]
    );
    await client.query(
      `INSERT INTO leads (name, whatsapp_e164, source, desired_plan, status)
       VALUES ($1, $2, 'whatsapp', $3, 'payment_pending')`,
      [customer.name, phone, planCode]
    );
    return { chargeId: chargeResult.rows[0].id, duplicate: false };
  });

  if (initialStatus === 'approved') {
    await queues.messages.add(
      'send-charge',
      { chargeId: result.chargeId, conversationWindow: true },
      {
        jobId: `charge-${result.chargeId}-${inbound.id}`,
        attempts: 20,
        backoff: { type: 'fixed', delay: 300_000 },
        removeOnComplete: 1000,
        removeOnFail: 2000
      }
    );
  } else {
    await queues.messages.add(
      'send-free-text',
      {
        customerId: customer.id,
        to: phone,
        text: `Perfeito! Você escolheu o plano ${plan.name}, no valor de ${(plan.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. A cobrança está aguardando aprovação no administrador.`
      },
      { jobId: `pending-${result.chargeId}` }
    );
  }
  await audit(db, {
    actorType: 'whatsapp',
    actorId: phone,
    action: 'sales.plan_selected',
    entityType: 'charge',
    entityId: result.chargeId,
    after: { planCode, salesMode, paused, duplicate: result.duplicate }
  });
  return { action: 'plan_selected', ...result };
}
