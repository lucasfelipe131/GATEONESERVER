import { createAIResponse } from '../integrations/openai.js';

const PLAN_TEXT =
  'Mensal: R$ 30 por 1 mês; Trimestral: R$ 85 por 3 meses; ' +
  'Semestral: R$ 150 por 6 meses; Anual: R$ 270 por 12 meses.';

const ADMIN_INSTRUCTIONS = `
Você é o Assistente Gate One Pro, dentro de um painel administrativo.
Responda em português do Brasil, de forma direta, prática e curta.
Use somente os dados operacionais enviados no contexto. Quando faltar informação, diga isso.
Você pode analisar indicadores, explicar filas, sugerir prioridades e orientar configurações.
Você não pode executar, confirmar ou fingir que executou pagamentos, cobranças, mensagens,
cadastros, renovações ou alterações no BitPanel. Nunca peça nem revele senhas, tokens,
chaves Pix, credenciais ou dados completos de cartão. Oriente o administrador a usar os
botões do painel para qualquer ação crítica.
`.trim();

const CUSTOMER_INSTRUCTIONS = `
Você é o atendimento virtual do Gate One Pro Server no WhatsApp.
Responda em português do Brasil, com simpatia, clareza e no máximo 700 caracteres.
Planos oficiais: ${PLAN_TEXT}
Os planos incluem esportes ao vivo, filmes e séries on-demand; a disponibilidade pode variar.
Use os dados do cliente enviados no contexto para informar plano, situação e vencimento.
Não invente confirmação de pagamento, canais específicos, disponibilidade de conteúdo,
renovação, cadastro ou alteração de acesso. Você não pode cobrar, renovar, alterar preço,
pedir senha, pedir token, pedir dados de cartão ou confirmar comprovante.
Para escolher um plano, peça ao cliente que escreva Mensal, Trimestral, Semestral ou Anual.
Para pagamento pendente, explique que a confirmação oficial ocorre pelo Mercado Pago.
Se o assunto exigir ação humana, oriente: "Digite ATENDENTE".
`.trim();

function compactHistory(rows) {
  return rows
    .reverse()
    .map((row) => `${row.role === 'assistant' ? 'Assistente' : 'Pessoa'}: ${row.content}`)
    .join('\n');
}

async function saveExchange(db, {
  audience,
  customerId = null,
  actorId = null,
  question,
  answer
}) {
  await db.transaction(async (client) => {
    await client.query(
      `INSERT INTO ai_messages (audience, customer_id, actor_id, role, content)
       VALUES ($1, $2, $3, 'user', $4)`,
      [audience, customerId, actorId, question]
    );
    await client.query(
      `INSERT INTO ai_messages
        (audience, customer_id, actor_id, role, content, model, provider_response_id)
       VALUES ($1, $2, $3, 'assistant', $4, $5, $6)`,
      [audience, customerId, actorId, answer.text, answer.model, answer.id]
    );
  });
}

export function requestsHumanSupport(text) {
  return /\b(atendente|humano|pessoa|suporte humano|falar com algu[eé]m)\b/i.test(
    String(text || '')
  );
}

export async function answerAdminQuestion({ db, config, user, question }) {
  const [customers, charges, renewals, revenue, expirations, failures, history] =
    await Promise.all([
      db.query(
        `SELECT status, count(*)::int AS total
           FROM customers GROUP BY status ORDER BY status`
      ),
      db.query(
        `SELECT status, count(*)::int AS total
           FROM charges GROUP BY status ORDER BY status`
      ),
      db.query(
        `SELECT status, count(*)::int AS total
           FROM renewal_jobs GROUP BY status ORDER BY status`
      ),
      db.query(
        `SELECT COALESCE(sum(amount_cents), 0)::int AS cents
           FROM charges
          WHERE status = 'paid' AND paid_at >= date_trunc('month', now())`
      ),
      db.query(
        `SELECT c.name, c.bitpanel_reference, s.expires_on::text, p.name AS plan_name
           FROM subscriptions s
           JOIN customers c ON c.id = s.customer_id
           JOIN plans p ON p.id = s.plan_id
          WHERE s.status IN ('active', 'late')
            AND s.expires_on <= CURRENT_DATE + 15
          ORDER BY s.expires_on
          LIMIT 30`
      ),
      db.query(
        `SELECT c.name, r.error, r.updated_at
           FROM renewal_jobs r
           JOIN charges ch ON ch.id = r.charge_id
           JOIN subscriptions s ON s.id = ch.subscription_id
           JOIN customers c ON c.id = s.customer_id
          WHERE r.status IN ('failed', 'manual_review')
          ORDER BY r.updated_at DESC
          LIMIT 15`
      ),
      db.query(
        `SELECT role, content FROM ai_messages
          WHERE audience = 'admin' AND actor_id = $1
          ORDER BY created_at DESC LIMIT 8`,
        [String(user.id)]
      )
    ]);
  const context = {
    generatedAt: new Date().toISOString(),
    plans: PLAN_TEXT,
    revenueThisMonthCents: revenue.rows[0].cents,
    customersByStatus: customers.rows,
    chargesByStatus: charges.rows,
    renewalsByStatus: renewals.rows,
    expiringOrLate: expirations.rows,
    recentRenewalFailures: failures.rows
  };
  const input = [
    `Contexto operacional do painel:\n${JSON.stringify(context, null, 2)}`,
    history.rows.length ? `Conversa recente:\n${compactHistory(history.rows)}` : '',
    `Pergunta do administrador ${user.name}:\n${question}`
  ].filter(Boolean).join('\n\n');
  const answer = await createAIResponse(config, {
    instructions: ADMIN_INSTRUCTIONS,
    input
  });
  await saveExchange(db, {
    audience: 'admin',
    actorId: String(user.id),
    question,
    answer
  });
  return answer;
}

export async function answerCustomerQuestion({ db, config, customerId, question }) {
  const [customer, history] = await Promise.all([
    db.query(
      `SELECT c.name, c.status, c.bitpanel_reference,
              s.expires_on::text, p.name AS plan_name
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT * FROM subscriptions
            WHERE customer_id = c.id
            ORDER BY created_at DESC LIMIT 1
         ) s ON true
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE c.id = $1`,
      [customerId]
    ),
    db.query(
      `SELECT role, content FROM ai_messages
        WHERE audience = 'customer' AND customer_id = $1
        ORDER BY created_at DESC LIMIT 6`,
      [customerId]
    )
  ]);
  const input = [
    `Dados permitidos do cliente:\n${JSON.stringify(customer.rows[0] || {}, null, 2)}`,
    history.rows.length ? `Conversa recente:\n${compactHistory(history.rows)}` : '',
    `Mensagem atual:\n${question}`
  ].filter(Boolean).join('\n\n');
  const answer = await createAIResponse(config, {
    instructions: CUSTOMER_INSTRUCTIONS,
    input,
    maxOutputTokens: Math.min(config.AI_MAX_OUTPUT_TOKENS || 700, 700)
  });
  await saveExchange(db, {
    audience: 'customer',
    customerId,
    actorId: String(customerId),
    question,
    answer
  });
  return answer;
}
