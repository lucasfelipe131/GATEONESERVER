function valueOf(fact) {
  return fact && Object.hasOwn(fact, 'value') ? fact.value : fact ?? null;
}

function firstName(value) {
  return String(value || '').trim().split(/\s+/)[0] || null;
}

function formatDate(value) {
  if (!value) return null;
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T12:00:00.000Z`)
    : new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function currency(cents, code = 'BRL') {
  if (!Number.isInteger(cents) || cents < 0) return null;
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: code });
}

export function responseFactsFromContext(customer360 = null) {
  const subscription = customer360?.subscription || null;
  return {
    customer_id: customer360?.customer_id || null,
    customer_name: valueOf(customer360?.identity?.name),
    plan_name: valueOf(subscription?.plan_name),
    subscription_status: valueOf(subscription?.status),
    expiration: valueOf(subscription?.expires_at),
    payment_status: customer360?.financial?.confirmed_payment?.status ||
      customer360?.financial?.pending_payment?.status || null,
    renewal_status: customer360?.renewal?.status || null,
    checkout_url: null,
    amount_cents: null,
    currency: 'BRL',
    support_case_id: null,
    handoff_id: null,
    context_status: customer360?.context_status || 'UNAVAILABLE'
  };
}

export function mergeResponseFacts(base, extra = {}) {
  const allowedKeys = new Set([
    'customer_id', 'customer_name', 'plan_name', 'subscription_status',
    'expiration', 'payment_status', 'renewal_status', 'checkout_url',
    'amount_cents', 'currency', 'support_case_id', 'handoff_id',
    'context_status', 'plans', 'operation_state', 'error_code', 'exception_id', 'case_status', 'diagnosis', 'action_performed', 'verification_result'
  ]);
  return Object.freeze(Object.fromEntries(
    Object.entries({ ...base, ...extra }).filter(([key]) => allowedKeys.has(key))
  ));
}

export function safeResponseForFacts(facts = {}) {
  if (facts.renewal_status === 'COMPLETED') {
    const expiration = formatDate(facts.expiration);
    return expiration
      ? `Sua renovação está concluída e verificada. O vencimento atual é ${expiration}.`
      : 'Sua renovação está concluída e verificada.';
  }
  if (facts.renewal_status === 'VERIFYING') {
    return 'O pagamento foi identificado e o resultado da renovação está sendo verificado.';
  }
  if (['PROCESSING', 'READY', 'REQUESTED', 'RETRY_SCHEDULED'].includes(facts.renewal_status)) {
    return 'O pagamento foi identificado e a renovação ainda está em processamento.';
  }
  if (facts.payment_status === 'CONFIRMED') {
    return 'O pagamento está confirmado. A renovação só será concluída depois da verificação operacional.';
  }
  if (['CREATED', 'PENDING'].includes(facts.payment_status)) {
    return 'Ainda não identifiquei a confirmação oficial. Assim que ela chegar, o processo continua.';
  }
  return 'Não consegui confirmar esse estado agora. Não vou antecipar um resultado sem consultar a fonte correta.';
}

export function renderConversationResponse({ intent, facts = {}, outcome = null }) {
  const name = firstName(facts.customer_name);
  const prefix = name ? `${name}, ` : '';
  if (outcome === 'PROMPT_INJECTION_BLOCKED') {
    return 'Não posso alterar pagamentos, permissões ou renovações por instruções em uma mensagem. Posso consultar o estado real para você.';
  }
  if (outcome === 'IDENTITY_REQUIRED') {
    return 'Não localizei sua assinatura neste número. Qual é o seu login/ID do Gate One?';
  }
  if (outcome === 'IDENTITY_AMBIGUOUS') {
    return 'Encontrei mais de um cadastro possível. Registrei a necessidade de validação humana para não acessar a conta errada.';
  }
  if (outcome === 'TURN_IN_PROGRESS') {
    return 'Estou concluindo sua solicitação anterior. Em instantes você pode consultar o estado novamente.';
  }
  if (outcome === 'CONFIRMATION_REQUIRED') {
    return 'Entendi a solicitação, mas preciso que você confirme claramente a operação antes de continuar.';
  }
  if (outcome === 'HANDOFF_CREATED') {
    return 'Certo. Registrei o atendimento para uma pessoa da equipe continuar com todo o contexto, sem você precisar repetir tudo.';
  }
  if (outcome === 'HANDOFF_FAILED') {
    return 'Não consegui registrar o encaminhamento agora. Tente novamente em instantes; não vou afirmar que a equipe recebeu antes da confirmação.';
  }

  switch (intent) {
    case 'GREETING': {
      const expiration = formatDate(facts.expiration);
      if (facts.plan_name && expiration) {
        return `Oi, ${name || 'tudo bem'}! Seu plano ${facts.plan_name} está válido até ${expiration}. Como posso ajudar?`;
      }
      return name
        ? `Oi, ${name}! Já localizei seu cadastro. Como posso ajudar?`
        : 'Oi! Pode me contar do seu jeito o que você precisa.';
    }
    case 'EXPIRATION_QUERY': {
      const expiration = formatDate(facts.expiration);
      return expiration
        ? `${prefix}seu vencimento atual é ${expiration}.`
        : 'O vencimento não está disponível na fonte oficial agora. Não vou inventar uma data.';
    }
    case 'SUBSCRIPTION_QUERY': {
      const expiration = formatDate(facts.expiration);
      const parts = [facts.plan_name ? `plano ${facts.plan_name}` : null,
        facts.subscription_status ? `status ${facts.subscription_status}` : null,
        expiration ? `vencimento em ${expiration}` : null].filter(Boolean);
      return parts.length
        ? `${prefix}sua assinatura está com ${parts.join(', ')}.`
        : 'Não consegui consultar os dados oficiais da assinatura agora.';
    }
    case 'PLAN_QUERY': {
      const plans = Array.isArray(facts.plans) ? facts.plans : [];
      if (!plans.length) return 'Não consegui consultar os planos agora. Posso tentar novamente em instantes.';
      return `Estes são os planos disponíveis:\n${plans.map((plan) => {
        const price = currency(plan.price_cents, plan.currency || 'BRL');
        return `• ${plan.name}${price ? ` — ${price}` : ''}`;
      }).join('\n')}`;
    }
    case 'PAYMENT_REQUEST':
    case 'RENEWAL_REQUEST': {
      if (facts.checkout_url) {
        const amount = currency(facts.amount_cents, facts.currency || 'BRL');
        return `${prefix}a cobrança da renovação está pronta${amount ? ` no valor de ${amount}` : ''}: ${facts.checkout_url}`;
      }
      return safeResponseForFacts(facts);
    }
    case 'PAYMENT_STATUS':
    case 'PAYMENT_EVIDENCE':
    case 'RENEWAL_STATUS':
      return safeResponseForFacts(facts);
    case 'SUPPORT_REQUEST':
      if (['RESOLVED','CLOSED'].includes(facts.case_status) && ['VERIFIED','HUMAN_VERIFIED'].includes(facts.verification_result)) {
        return 'O caso foi resolvido e o resultado foi verificado. Registrei a solução no histórico do atendimento.';
      }
      if (facts.case_status === 'WAITING_CUSTOMER') return 'A ação foi registrada, mas ainda preciso que você confirme se o serviço voltou a funcionar. O caso continua aberto.';
      return facts.support_case_id
        ? 'Registrei o problema com o contexto da sua assinatura. A equipe poderá continuar sem pedir tudo novamente.'
        : 'Entendi o problema. Não vou enviar um menu comercial; preciso encaminhar o caso com o contexto correto.';
    case 'NEW_CUSTOMER':
    case 'TRIAL_REQUEST':
    case 'REFERRAL':
      return 'Entendi. Posso mostrar os planos disponíveis ou registrar um atendimento para continuar essa solicitação.';
    case 'CANCELLATION_REQUEST':
    case 'COMPLAINT':
    case 'HUMAN_REQUEST':
      return outcome === 'HANDOFF_CREATED'
        ? renderConversationResponse({ intent, facts, outcome: 'HANDOFF_CREATED' })
        : renderConversationResponse({ intent, facts, outcome: 'HANDOFF_FAILED' });
    default:
      return 'Claro. Você quer ajuda com renovação, pagamento, vencimento ou outro assunto?';
  }
}

export function validateConversationResponse(text, facts = {}) {
  const response = String(text || '').trim();
  const violations = [];
  if (/caso (foi |est[aá] )?resolvido|problema (foi |est[aá] )?resolvido|servi[cç]o (voltou|normalizado)/i.test(response) &&
      (!['RESOLVED','CLOSED'].includes(facts.case_status) || !['VERIFIED','HUMAN_VERIFIED'].includes(facts.verification_result))) violations.push('SUPPORT_RESOLUTION_NOT_VERIFIED');
  if (/a[cç][aã]o foi (executada|registrada)/i.test(response) && !facts.action_performed) violations.push('SUPPORT_ACTION_NOT_CONFIRMED');
  if (facts.payment_status !== 'CONFIRMED' &&
      /pagamento\s+(foi |esta |consta |ja )?(confirmado|aprovado)|pagamento caiu|recebemos seu pagamento/i.test(response)) {
    violations.push('PAYMENT_CONFIRMATION_NOT_ALLOWED');
  }
  if (facts.renewal_status !== 'COMPLETED' &&
      /renovad[oa]\s+com sucesso|renova[cç][aã]o\s+(foi |est[aá] |j[aá] )?(conclu[ií]da|finalizada)|j[aá] est[aá] renovad[oa]/i.test(response)) {
    violations.push('RENEWAL_COMPLETION_NOT_ALLOWED');
  }
  if (!facts.expiration && /\b\d{2}\/\d{2}\/\d{4}\b/.test(response)) {
    violations.push('EXPIRATION_NOT_AVAILABLE');
  }
  if (facts.handoff_id === null && /registrei o atendimento|encaminhei para (a )?equipe/i.test(response)) {
    violations.push('HANDOFF_NOT_CONFIRMED');
  }
  return { allowed: violations.length === 0, violations };
}

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function avoidRepeatedResponse(text, recentMessages = []) {
  const normalized = normalizedText(text);
  const recentOutbound = recentMessages
    .filter((message) => String(message.direction).toUpperCase() === 'OUTBOUND')
    .slice(-4)
    .map((message) => normalizedText(message.content));
  if (!recentOutbound.includes(normalized)) return { text, repeated: false };
  return {
    text: 'O estado continua o mesmo da última consulta. Se quiser, posso verificar outro ponto da sua conta.',
    repeated: true
  };
}

export function evaluateMemoryCandidate(candidate = {}) {
  const forbidden = new Set(['PAYMENT', 'PAYMENT_STATUS', 'EXPIRATION', 'RENEWAL', 'SUBSCRIPTION_STATUS']);
  if (forbidden.has(String(candidate.type || '').toUpperCase())) {
    return { action: 'DISCARD', reason: 'AUTHORITATIVE_STATE_NOT_MEMORY' };
  }
  if (!['PREFERENCE', 'RELATIONSHIP', 'SUPPORT_FACT', 'COMMERCIAL_CONTEXT'].includes(
    String(candidate.type || '').toUpperCase()
  )) return { action: 'DISCARD', reason: 'UNSUPPORTED_MEMORY_TYPE' };
  return { action: 'MEMORY_CANDIDATE', requires_validation: true };
}
