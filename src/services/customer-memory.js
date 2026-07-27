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

async function saveInboundLog(db, customerId, { text, providerId }) {
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
      (customer_id, direction, channel, content, provider_id, status)
     VALUES ($1, 'inbound', 'whatsapp_qr', $2, $3, 'received')`,
    [customerId, String(text || '').slice(0, 4000), providerId || null]
  );
  return true;
}

async function recordIssue(db, customerId, text, issue) {
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
              last_mentioned_at = now(), status = 'open', updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [previousIssue.id, String(text).slice(0, 1000)]
    );
    return { current: updated.rows[0], previous: previousIssue };
  }
  const inserted = await db.query(
    `INSERT INTO customer_issues
      (customer_id, category, summary, last_message, status)
     VALUES ($1, $2, $3, $4, 'open')
     RETURNING *`,
    [customerId, issue.category, issue.label, String(text).slice(0, 1000)]
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
  await db.query(
    `INSERT INTO conversation_sessions (whatsapp_e164, state, data, expires_at)
     VALUES ($1, $2, $3::jsonb, now() + interval '24 hours')
     ON CONFLICT (whatsapp_e164) DO UPDATE
       SET state = EXCLUDED.state, data = EXCLUDED.data,
           expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [normalized, state, JSON.stringify(data)]
  );
}

export async function registerQrInbound(db, {
  phone,
  displayName = null,
  text,
  providerId = null
}) {
  const normalized = normalizePhone(phone);
  const customer = await findOrCreateCustomer(db, { phone: normalized, displayName });
  const saved = await saveInboundLog(db, customer.id, { text, providerId });
  const issue = detectCustomerIssue(text);
  const issueRecord = saved
    ? await recordIssue(db, customer.id, text, issue)
    : { current: null, previous: null };
  let session = await loadSession(db, normalized);
  const needsName = !cleanCustomerName(customer.name);
  if (needsName && session?.state !== 'awaiting_login') {
    await setConversationState(db, normalized, 'awaiting_name', { customerId: customer.id });
    session = { state: 'awaiting_name', data: { customerId: customer.id } };
  }
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
    sessionState: session?.state || 'menu',
    recentIssues: recentIssues.rows,
    supportMessage: buildSupportMessage(issue, issueRecord.previous)
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
            customerId: current.rows[0].id,
            candidateId: matches.rows[0].id
          })
        ]
      );
      return { name: cleaned, needsLogin: true };
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
    return { name: cleaned, needsLogin: false };
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
        WHERE whatsapp_e164 = $1 AND state = 'awaiting_login' AND expires_at > now()
        FOR UPDATE`,
      [normalized]
    );
    const temporaryId = session.rows[0]?.data?.customerId;
    const candidateId = session.rows[0]?.data?.candidateId;
    if (!temporaryId || !candidateId) {
      throw Object.assign(new Error('A confirmação expirou. Digite MENU para começar novamente.'), {
        statusCode: 409
      });
    }
    const candidate = await client.query(
      `SELECT * FROM customers
        WHERE id = $1 AND lower(trim(bitpanel_reference)) = $2
        FOR UPDATE`,
      [candidateId, normalizedLogin]
    );
    if (!candidate.rows[0]) {
      return { matched: false };
    }
    await client.query(
      `UPDATE customers SET whatsapp_e164 = NULL, updated_at = now() WHERE id = $1`,
      [temporaryId]
    );
    await client.query(
      `UPDATE customers
          SET whatsapp_e164 = $2, name_confirmed_at = now(),
              consent_contact = true, opt_out_at = NULL, updated_at = now()
        WHERE id = $1`,
      [candidateId, normalized]
    );
    await client.query(
      `UPDATE message_logs SET customer_id = $2 WHERE customer_id = $1`,
      [temporaryId, candidateId]
    );
    await client.query(
      `UPDATE customer_issues SET customer_id = $2 WHERE customer_id = $1`,
      [temporaryId, candidateId]
    );
    await client.query(`DELETE FROM customers WHERE id = $1`, [temporaryId]);
    await client.query(
      `UPDATE conversation_sessions
          SET state = 'menu', data = $2::jsonb,
              expires_at = now() + interval '24 hours', updated_at = now()
        WHERE whatsapp_e164 = $1`,
      [normalized, JSON.stringify({ customerId: candidateId })]
    );
    return { matched: true, name: candidate.rows[0].name };
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
  await db.query(
    `INSERT INTO message_logs
      (customer_id, direction, channel, content, provider_id, status)
     VALUES ($1, 'outbound', 'whatsapp_qr', $2, $3, 'sent')`,
    [customer.id, String(text || '').slice(0, 4000), providerId]
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
