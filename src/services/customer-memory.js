import { randomUUID } from 'node:crypto';
import { normalizePhone } from '../security.js';

const PLACEHOLDER_NAMES = new Set(['', 'cliente', 'customer', 'sem nome', 'não informado']);

const ISSUE_RULES = [
  {
    category: 'buffering',
    label: 'travamentos ou carregamento',
    pattern: /\b(trav(?:a|ado|ando|ou)|congel(?:a|ado|ando|ou)|buffer(?:ing)?|carregando|fica parando|muito lento)\b/i,
    guidance:
      'Desligue a TV/aparelho e o roteador da tomada por 30 segundos. Ligue primeiro o roteador, aguarde a internet voltar e depois ligue o aparelho.'
  },
  {
    category: 'audio_video',
    label: 'áudio ou imagem',
    pattern: /\b(sem (?:som|audio|áudio|imagem)|tela preta|voz atrasad|som atrasad|imagem atrasad|fora de sincronia)\b/i,
    guidance:
      'Feche e abra o aplicativo, teste outro canal e reinicie a TV/aparelho. Se continuar, informe o nome do aplicativo e do conteúdo afetado.'
  },
  {
    category: 'login',
    label: 'login ou acesso',
    pattern: /\b(login|senha|usuario|usuário|acesso).{0,30}\b(erro|incorret|invalid|inválid|bloquead|expirad|não entra|nao entra)\b|\b(erro|problema).{0,20}\b(login|senha|acesso)\b/i,
    guidance:
      'Confira se o login foi digitado sem espaços e se a assinatura está válida. Não envie sua senha completa; se persistir, digite ATENDENTE.'
  },
  {
    category: 'installation',
    label: 'instalação ou aplicativo',
    pattern: /\b(instalar|instalação|instalacao|configurar|aplicativo|app|smart tv|tv box).{0,35}\b(erro|problema|não consigo|nao consigo|ajuda)\b|\b(erro|problema).{0,25}\b(aplicativo|app)\b/i,
    guidance:
      'Informe a marca/modelo da TV ou aparelho e o nome do aplicativo. Assim indicamos o procedimento correto sem alterar seu acesso.'
  },
  {
    category: 'connection',
    label: 'conexão ou indisponibilidade',
    pattern: /\b(sem sinal|não abre|nao abre|fora do ar|indispon[ií]vel|erro de conex[aã]o|não funciona|nao funciona)\b/i,
    guidance:
      'Teste a internet no mesmo aparelho e reinicie o roteador e a TV/aparelho. Depois informe se o erro ocorre em tudo ou somente em um conteúdo.'
  },
  {
    category: 'payment',
    label: 'pagamento não reconhecido',
    pattern: /\b(paguei|pagamento|pix|comprovante|cobrança|cobranca).{0,35}\b(não confirmou|nao confirmou|não caiu|nao caiu|pendente|erro|problema)\b|\b(não confirmou|nao confirmou).{0,25}\b(pagamento|pix)\b/i,
    guidance:
      'A confirmação oficial é feita automaticamente pelo Mercado Pago. Digite MINHA CONTA para consultar o status; se já foi aprovado e não apareceu, digite ATENDENTE.'
  }
];

export function cleanCustomerName(value) {
  const cleaned = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{M}' -]/gu, '')
    .trim();
  if (cleaned.length < 2 || cleaned.length > 120) return null;
  if (PLACEHOLDER_NAMES.has(cleaned.toLocaleLowerCase('pt-BR'))) return null;
  return cleaned
    .toLocaleLowerCase('pt-BR')
    .replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toLocaleUpperCase('pt-BR'));
}

export function isProbableCustomerName(value) {
  const name = cleanCustomerName(value);
  if (!name) return false;
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  return !/\b(oi|olá|ola|menu|plano|mensal|trimestral|semestral|anual|pix|pagamento|ajuda|suporte|atendente)\b/i.test(
    name
  );
}

export function resolveIntegrationPhone({ phone = null, whatsapp = null } = {}) {
  return normalizePhone(phone || whatsapp);
}

export function detectCustomerIssue(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const rule = ISSUE_RULES.find((candidate) => candidate.pattern.test(value));
  return rule ? { category: rule.category, label: rule.label, guidance: rule.guidance } : null;
}

function issueDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function buildSupportMessage(issue, previousIssue = null) {
  if (!issue) return null;
  return [
    previousIssue
      ? `Encontrei um atendimento anterior sobre *${issue.label}* em ${issueDate(previousIssue.first_reported_at)}. Vamos continuar de onde paramos.`
      : `Entendi. Registrei este atendimento como problema de *${issue.label}*.`,
    issue.guidance,
    'Se não resolver, responda *ATENDENTE* e o histórico ficará disponível para a equipe.'
  ].join('\n\n');
}

async function findOrCreateCustomer(db, { phone, displayName = null }) {
  const normalized = normalizePhone(phone);
  const found = await db.query(
    `SELECT * FROM customers WHERE whatsapp_e164 = $1 LIMIT 1`,
    [normalized]
  );
  if (found.rows[0]) {
    if (displayName) {
      await db.query(
        `UPDATE customers
            SET whatsapp_display_name = $2, updated_at = now()
          WHERE id = $1`,
        [found.rows[0].id, String(displayName).slice(0, 120)]
      );
    }
    return { ...found.rows[0], whatsapp_display_name: displayName || found.rows[0].whatsapp_display_name };
  }
  const inserted = await db.query(
    `INSERT INTO customers
      (name, whatsapp_e164, whatsapp_display_name, source, status, operational_stage,
       consent_contact)
     VALUES (NULL, $1, $2, 'whatsapp_qr', 'lead', 'review', true)
     RETURNING *`,
    [normalized, displayName ? String(displayName).slice(0, 120) : null]
  );
  return inserted.rows[0];
}

function contextStateFromLegacy(state) {
  const normalized = String(state || '').toLowerCase();
  if (normalized.includes('support')) return 'SUPPORT';
  if (normalized.includes('handoff')) return 'HUMAN_HANDOFF';
  if (normalized.includes('payment') || normalized.includes('plan')) return 'WAITING_PAYMENT';
  if (normalized.includes('renew')) return 'RENEWAL';
  if (normalized.includes('sale')) return 'SALES';
  if (normalized.includes('recovery')) return 'RECOVERY';
  if (normalized.includes('name') || normalized.includes('login')) return 'NEW_CONTACT';
  return 'GENERAL';
}

function contentTypeFromText(text) {
  const value = String(text || '');
  if (/^\[Áudio/i.test(value)) return 'AUDIO';
  if (/^\[Imagem/i.test(value)) return 'IMAGE';
  if (/^\[(?:PDF|Documento)/i.test(value)) return /PDF/i.test(value) ? 'PDF' : 'DOCUMENT';
  if (/^\[Mensagem do WhatsApp recebida:/i.test(value)) return 'UNKNOWN';
  return 'TEXT';
}

async function touchConversation(db, {
  phone,
  customerId,
  state = 'conversation',
  data = {},
  correlationId = randomUUID(),
  pendingActions = []
}) {
  const conversationId = randomUUID();
  const result = await db.query(
    `INSERT INTO conversation_sessions
      (whatsapp_e164, state, data, expires_at, conversation_id, customer_id,
       channel, context_state, started_at, last_activity_at, handoff_status,
       correlation_id, pending_actions, revision)
     VALUES ($1, $2, $3::jsonb, now() + interval '24 hours', $4, $5,
             'whatsapp_qr', $6, now(), now(), $7, $8, $9::jsonb, 1)
     ON CONFLICT (whatsapp_e164) DO UPDATE
       SET state = EXCLUDED.state,
           data = conversation_sessions.data || EXCLUDED.data,
           expires_at = EXCLUDED.expires_at,
           conversation_id = COALESCE(conversation_sessions.conversation_id, EXCLUDED.conversation_id),
           customer_id = EXCLUDED.customer_id,
           channel = COALESCE(conversation_sessions.channel, EXCLUDED.channel),
           context_state = EXCLUDED.context_state,
           started_at = COALESCE(conversation_sessions.started_at, EXCLUDED.started_at),
           last_activity_at = EXCLUDED.last_activity_at,
           handoff_status = EXCLUDED.handoff_status,
           correlation_id = EXCLUDED.correlation_id,
           pending_actions = EXCLUDED.pending_actions,
           revision = conversation_sessions.revision + 1,
           updated_at = now()
     RETURNING conversation_id, correlation_id, revision`,
    [
      phone,
      state,
      JSON.stringify(data),
      conversationId,
      customerId,
      contextStateFromLegacy(state),
      state === 'support' ? 'REQUESTED' : 'NONE',
      correlationId,
      JSON.stringify(pendingActions)
    ]
  );
  return result.rows[0];
}

async function touchConversationActivity(db, {
  phone,
  customerId,
  correlationId = randomUUID()
}) {
  const conversationId = randomUUID();
  const result = await db.query(
    `INSERT INTO conversation_sessions
      (whatsapp_e164, state, data, expires_at, conversation_id, customer_id,
       channel, context_state, started_at, last_activity_at, handoff_status,
       correlation_id, pending_actions, revision)
     VALUES ($1, 'conversation', '{}'::jsonb, now() + interval '24 hours', $2, $3,
             'whatsapp_qr', 'GENERAL', now(), now(), 'NONE', $4, '[]'::jsonb, 1)
     ON CONFLICT (whatsapp_e164) DO UPDATE
       SET conversation_id = COALESCE(conversation_sessions.conversation_id, EXCLUDED.conversation_id),
           customer_id = EXCLUDED.customer_id,
           channel = COALESCE(conversation_sessions.channel, EXCLUDED.channel),
           started_at = COALESCE(conversation_sessions.started_at, EXCLUDED.started_at),
           last_activity_at = EXCLUDED.last_activity_at,
           correlation_id = EXCLUDED.correlation_id,
           revision = conversation_sessions.revision + 1,
           updated_at = now()
     RETURNING conversation_id, correlation_id, revision`,
    [phone, conversationId, customerId, correlationId]
  );
  return result.rows[0];
}

async function saveInboundLog(db, customerId, {
  text,
  providerId,
  conversationId,
  correlationId
}) {
  if (providerId) {
    const duplicate = await db.query(
      `SELECT 1 FROM message_logs
        WHERE channel = 'whatsapp_qr' AND provider_id = $1 LIMIT 1`,
      [providerId]
    );
    if (duplicate.rows[0]) return false;
  }
  await db.query(
    `INSERT INTO message_logs
      (customer_id, direction, channel, content, provider_id, status,
       conversation_id, content_type, processing_status, correlation_id)
     VALUES ($1, 'inbound', 'whatsapp_qr', $2, $3, 'received',
             $4, $5, 'RECEIVED', $6)`,
    [
      customerId,
      String(text || '').slice(0, 4000),
      providerId || null,
      conversationId,
      contentTypeFromText(text),
      correlationId
    ]
  );
  return true;
}

async function recordIssue(db, customerId, text, issue, correlationId) {
  if (!issue) return { current: null, previous: null };
  const previous = await db.query(
    `SELECT * FROM customer_issues
      WHERE customer_id = $1 AND category = $2
      ORDER BY last_mentioned_at DESC LIMIT 1`,
    [customerId, issue.category]
  );
  const previousIssue = previous.rows[0] || null;
  if (previousIssue && previousIssue.status !== 'resolved') {
    const updated = await db.query(
      `UPDATE customer_issues
          SET last_message = $2, occurrences = occurrences + 1,
              last_mentioned_at = now(), status = 'open',
              correlation_id = $3, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [previousIssue.id, String(text).slice(0, 1000), correlationId]
    );
    return { current: updated.rows[0], previous: previousIssue };
  }
  const inserted = await db.query(
    `INSERT INTO customer_issues
      (customer_id, category, summary, last_message, status, correlation_id)
     VALUES ($1, $2, $3, $4, 'open', $5)
     RETURNING *`,
    [customerId, issue.category, issue.label, String(text).slice(0, 1000), correlationId]
  );
  return { current: inserted.rows[0], previous: previousIssue };
}

async function loadSession(db, phone) {
  const result = await db.query(
    `SELECT state, data, expires_at FROM conversation_sessions
      WHERE whatsapp_e164 = $1 AND expires_at > now()`,
    [phone]
  );
  return result.rows[0] || null;
}

export async function setConversationState(db, phone, state, data = {}) {
  const normalized = normalizePhone(phone);
  const customer = await db.query(
    'SELECT id FROM customers WHERE whatsapp_e164 = $1 LIMIT 1',
    [normalized]
  );
  if (!customer.rows[0]) return null;
  return touchConversation(db, {
    phone: normalized,
    customerId: customer.rows[0].id,
    state,
    data,
    pendingActions: data?.intent ? [{ type: upperIntent(data.intent), status: 'PENDING' }] : []
  });
}

function upperIntent(value) {
  return String(value || '').trim().toUpperCase();
}

export async function registerQrInbound(db, {
  phone,
  displayName = null,
  text,
  providerId = null
}) {
  const normalized = normalizePhone(phone);
  const customer = await findOrCreateCustomer(db, { phone: normalized, displayName });
  const conversation = await touchConversationActivity(db, {
    phone: normalized,
    customerId: customer.id
  });
  const saved = await saveInboundLog(db, customer.id, {
    text,
    providerId,
    conversationId: conversation.conversation_id,
    correlationId: conversation.correlation_id
  });
  const issue = detectCustomerIssue(text);
  const issueRecord = saved
    ? await recordIssue(db, customer.id, text, issue, conversation.correlation_id)
    : { current: null, previous: null };
  const session = await loadSession(db, normalized);
  const needsName = !cleanCustomerName(customer.name);
  const recentIssues = await db.query(
    `SELECT category, summary, status, occurrences, first_reported_at, last_mentioned_at
       FROM customer_issues
      WHERE customer_id = $1
      ORDER BY last_mentioned_at DESC LIMIT 3`,
    [customer.id]
  );
  return {
    customer: {
      id: customer.id,
      name: cleanCustomerName(customer.name),
      displayName: customer.whatsapp_display_name || displayName || null
    },
    needsName,
    duplicate: !saved,
    conversationId: conversation.conversation_id,
    correlationId: conversation.correlation_id,
    sessionState: session?.state || 'idle',
    recentIssues: recentIssues.rows,
    supportMessage: buildSupportMessage(issue, issueRecord.previous)
  };
}

function pendingIntentFields(data = {}) {
  const intent = ['account', 'payment'].includes(data?.intent) ? data.intent : null;
  const planCode = ['monthly', 'quarterly', 'semiannual', 'annual'].includes(data?.planCode)
    ? data.planCode
    : null;
  return {
    pendingIntent: intent,
    pendingPlanCode: intent === 'payment' ? planCode : null
  };
}

export async function confirmCustomerName(db, payload) {
  const { name } = payload;
  const normalized = resolveIntegrationPhone(payload);
  const cleaned = cleanCustomerName(name);
  if (!cleaned) {
    throw Object.assign(new Error('Informe um nome válido, usando apenas letras.'), {
      statusCode: 400
    });
  }
  await findOrCreateCustomer(db, { phone: normalized });
  return db.transaction(async (client) => {
    const activeSession = await client.query(
      `SELECT state, data FROM conversation_sessions
        WHERE whatsapp_e164 = $1 AND expires_at > now()
        FOR UPDATE`,
      [normalized]
    );
    const pendingData = activeSession.rows[0]?.data || {};
    const current = await client.query(
      `SELECT * FROM customers WHERE whatsapp_e164 = $1 FOR UPDATE`,
      [normalized]
    );
    if (!current.rows[0]) throw new Error('Não foi possível preparar o cadastro.');
    const matches = await client.query(
      `SELECT id, name, bitpanel_reference, whatsapp_e164
         FROM customers
        WHERE id <> $1 AND lower(trim(name)) = lower(trim($2))
        ORDER BY updated_at DESC LIMIT 2`,
      [current.rows[0].id, cleaned]
    );
    if (
      matches.rows.length === 1 &&
      matches.rows[0].bitpanel_reference &&
      matches.rows[0].whatsapp_e164 !== normalized
    ) {
      await client.query(
        `UPDATE customers SET name = $2, name_confirmed_at = now(), updated_at = now()
          WHERE id = $1`,
        [current.rows[0].id, cleaned]
      );
      await client.query(
        `INSERT INTO conversation_sessions (whatsapp_e164, state, data, expires_at)
         VALUES ($1, 'awaiting_login', $2::jsonb, now() + interval '24 hours')
         ON CONFLICT (whatsapp_e164) DO UPDATE
           SET state = EXCLUDED.state, data = EXCLUDED.data,
               expires_at = EXCLUDED.expires_at, updated_at = now()`,
        [
          normalized,
          JSON.stringify({
            ...pendingData,
            customerId: current.rows[0].id,
            candidateId: matches.rows[0].id
          })
        ]
      );
      return { name: cleaned, needsLogin: true, ...pendingIntentFields(pendingData) };
    }
    await client.query(
      `UPDATE customers
          SET name = $2, name_confirmed_at = now(),
              operational_stage = CASE
                WHEN operational_stage = 'review' THEN 'create_login'
                ELSE operational_stage
              END,
              updated_at = now()
        WHERE id = $1`,
      [current.rows[0].id, cleaned]
    );
    await client.query(
      `INSERT INTO conversation_sessions (whatsapp_e164, state, data, expires_at)
       VALUES ($1, 'menu', $2::jsonb, now() + interval '24 hours')
       ON CONFLICT (whatsapp_e164) DO UPDATE
         SET state = EXCLUDED.state, data = EXCLUDED.data,
             expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [normalized, JSON.stringify({ customerId: current.rows[0].id })]
    );
    return { name: cleaned, needsLogin: false, ...pendingIntentFields(pendingData) };
  });
}

export async function confirmCustomerLogin(db, payload) {
  const { login } = payload;
  const normalized = resolveIntegrationPhone(payload);
  const normalizedLogin = String(login || '').trim().toLocaleLowerCase('pt-BR');
  if (normalizedLogin.length < 3 || normalizedLogin.length > 80) {
    throw Object.assign(new Error('Informe o login/ID usado no Gate One.'), { statusCode: 400 });
  }
  return db.transaction(async (client) => {
    const session = await client.query(
      `SELECT data FROM conversation_sessions
        WHERE whatsapp_e164 = $1 AND expires_at > now()
        FOR UPDATE`,
      [normalized]
    );
    const current = await client.query(
      `SELECT * FROM customers WHERE whatsapp_e164 = $1 FOR UPDATE`,
      [normalized]
    );
    const temporaryId = current.rows[0]?.id || session.rows[0]?.data?.customerId;
    const pending = pendingIntentFields(session.rows[0]?.data || {});
    const candidate = await client.query(
      `SELECT * FROM customers
        WHERE lower(trim(bitpanel_reference)) = $1
        ORDER BY updated_at DESC
        LIMIT 2 FOR UPDATE`,
      [normalizedLogin]
    );
    if (candidate.rows.length !== 1) {
      return { matched: false };
    }
    const target = candidate.rows[0];
    if (target.whatsapp_e164 && target.whatsapp_e164 !== normalized) {
      await client.query(
        `INSERT INTO customer_identity_links
          (whatsapp_e164, source_customer_id, candidate_customer_id,
           claimed_login, status, reason, confidence)
         VALUES ($1, $2, $3, $4, 'pending', 'login_already_has_phone', 100)
         ON CONFLICT (whatsapp_e164, lower(claimed_login)) WHERE status = 'pending'
         DO UPDATE SET candidate_customer_id = EXCLUDED.candidate_customer_id,
                       source_customer_id = EXCLUDED.source_customer_id,
                       updated_at = now()`,
        [normalized, temporaryId || null, target.id, normalizedLogin]
      );
      return { matched: false, needsReview: true, reason: 'login_already_has_phone' };
    }
    if (target.whatsapp_e164 === normalized) {
      await client.query(
        `UPDATE conversation_sessions
            SET state = 'menu', data = $2::jsonb,
                customer_id = $3, context_state = 'GENERAL',
                last_activity_at = now(), revision = revision + 1,
                expires_at = now() + interval '24 hours', updated_at = now()
          WHERE whatsapp_e164 = $1`,
        [normalized, JSON.stringify({ customerId: target.id }), target.id]
      );
      return { matched: true, alreadyLinked: true, name: target.name, ...pending };
    }
    await client.query(
      `UPDATE customers
          SET whatsapp_e164 = $2, name_confirmed_at = now(),
              consent_contact = true, opt_out_at = NULL, updated_at = now()
        WHERE id = $1`,
      [target.id, normalized]
    );
    if (temporaryId && temporaryId !== target.id) {
      await client.query(
        `UPDATE message_logs SET customer_id = $2 WHERE customer_id = $1`,
        [temporaryId, target.id]
      );
      await client.query(
        `UPDATE customer_issues SET customer_id = $2 WHERE customer_id = $1`,
        [temporaryId, target.id]
      );
      await client.query(`DELETE FROM customers WHERE id = $1`, [temporaryId]);
    }
    await client.query(
      `INSERT INTO customer_identity_links
        (whatsapp_e164, source_customer_id, candidate_customer_id,
         claimed_login, status, reason, confidence, resolved_at)
       VALUES ($1, NULL, $2, $3, 'confirmed', 'exact_login', 100, now())`,
      [normalized, target.id, normalizedLogin]
    );
    await client.query(
      `UPDATE conversation_sessions
          SET state = 'menu', data = $2::jsonb,
              customer_id = $3, context_state = 'GENERAL',
              last_activity_at = now(), revision = revision + 1,
              expires_at = now() + interval '24 hours', updated_at = now()
        WHERE whatsapp_e164 = $1`,
      [normalized, JSON.stringify({ customerId: target.id }), target.id]
    );
    return { matched: true, name: target.name, ...pending };
  });
}

export async function logQrOutbound(db, { phone, text, providerId = null }) {
  const customer = await findOrCreateCustomer(db, { phone });
  if (providerId) {
    const duplicate = await db.query(
      `SELECT 1 FROM message_logs
        WHERE channel = 'whatsapp_qr' AND provider_id = $1 LIMIT 1`,
      [providerId]
    );
    if (duplicate.rows[0]) return { logged: false, duplicate: true };
  }
  const conversation = await touchConversationActivity(db, {
    phone: normalizePhone(phone),
    customerId: customer.id
  });
  await db.query(
    `INSERT INTO message_logs
      (customer_id, direction, channel, content, provider_id, status,
       conversation_id, content_type, processing_status, correlation_id)
     VALUES ($1, 'outbound', 'whatsapp_qr', $2, $3, 'sent',
             $4, 'TEXT', 'SENT', $5)`,
    [
      customer.id,
      String(text || '').slice(0, 4000),
      providerId,
      conversation.conversation_id,
      conversation.correlation_id
    ]
  );
  return { logged: true };
}

export async function customerHistoryMessage(db, phone) {
  const normalized = normalizePhone(phone);
  const result = await db.query(
    `SELECT c.name,
            COALESCE((
              SELECT jsonb_agg(item ORDER BY item.last_mentioned_at DESC)
                FROM (
                  SELECT summary, status, occurrences, last_mentioned_at
                    FROM customer_issues
                   WHERE customer_id = c.id
                   ORDER BY last_mentioned_at DESC LIMIT 3
                ) item
            ), '[]'::jsonb) AS issues
       FROM customers c WHERE c.whatsapp_e164 = $1 LIMIT 1`,
    [normalized]
  );
  const customer = result.rows[0];
  if (!customer) return null;
  const issues = Array.isArray(customer.issues) ? customer.issues : [];
  if (!issues.length) {
    return `Olá, ${cleanCustomerName(customer.name)?.split(/\s+/)[0] || 'cliente'}! Não há problemas anteriores registrados neste número.`;
  }
  return [
    `Olá, ${cleanCustomerName(customer.name)?.split(/\s+/)[0] || 'cliente'}! Encontrei estes atendimentos recentes:`,
    ...issues.map(
      (item) =>
        `• ${item.summary} — ${item.status === 'resolved' ? 'resolvido' : 'em acompanhamento'} (${issueDate(item.last_mentioned_at)})`
    ),
    '',
    'Conte se algum deles continua ou digite ATENDENTE.'
  ].join('\n');
}
