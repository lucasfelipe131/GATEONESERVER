export const CONVERSATION_INTENTS = Object.freeze([
  'GREETING',
  'RENEWAL_REQUEST',
  'PAYMENT_REQUEST',
  'PAYMENT_METHODS_QUERY',
  'PAYMENT_STATUS',
  'PAYMENT_EVIDENCE',
  'EXPIRATION_QUERY',
  'RENEWAL_STATUS',
  'SUBSCRIPTION_QUERY',
  'SUPPORT_REQUEST',
  'PLAN_QUERY',
  'NEW_CUSTOMER',
  'TRIAL_REQUEST',
  'CANCELLATION_REQUEST',
  'REFERRAL',
  'HUMAN_REQUEST',
  'COMPLAINT',
  'UNKNOWN'
]);

export const INTENT_CONFIDENCE = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9? ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const PLAN_CHOICES = [
  ['monthly', /\b(MENSAL|1 MES)\b/], ['quarterly', /\b(TRIMESTRAL|3 MESES)\b/],
  ['semiannual', /\b(SEMESTRAL|6 MESES)\b/], ['annual', /\b(ANUAL|12 MESES)\b/]
];

export function detectRequestedPlan(value) {
  const text = normalize(value);
  if (/\b(NAO|NUNCA|SEM|COMO|QUANTO|QUAL|PRECO|VALOR|CUSTA|SABER|ENTENDER)\b/.test(text)) return null;
  const exact = { MENSAL: 'monthly', '30': 'monthly', '1 MES': 'monthly', 'PLANO MENSAL': 'monthly',
    TRIMESTRAL: 'quarterly', '85': 'quarterly', '3 MESES': 'quarterly', 'PLANO TRIMESTRAL': 'quarterly',
    SEMESTRAL: 'semiannual', '150': 'semiannual', '6 MESES': 'semiannual', 'PLANO SEMESTRAL': 'semiannual',
    ANUAL: 'annual', '270': 'annual', '12 MESES': 'annual', 'PLANO ANUAL': 'annual' };
  if (Object.hasOwn(exact, text)) return exact[text];
  if (!/\b(RENOVAR|RENOVACAO|QUERO|ESCOLHO|PREFIRO|PODE GERAR|ENVIE|MANDA)\b/.test(text)) return null;
  const choices = PLAN_CHOICES.filter(([, pattern]) => pattern.test(text));
  return choices.length === 1 ? choices[0][0] : null;
}

const RULES = Object.freeze([
  ['HUMAN_REQUEST', /^4$|\b(ATENDENTE|HUMANO|PESSOA|FALAR COM (ALGUEM|A EQUIPE|ATENDENTE)|QUERO AJUDA HUMANA)\b/, 'HIGH'],
  ['CANCELLATION_REQUEST', /\b(CANCELAR|CANCELAMENTO|ENCERRAR (O )?PLANO|NAO QUERO MAIS)\b/, 'HIGH'],
  ['COMPLAINT', /\b(RECLAMACAO|RECLAMAR|ABSURDO|PESSIMO|INSATISFEIT[OA]|NAO AGUENTO MAIS)\b/, 'HIGH'],
  ['REFERRAL', /\b(INDICAR|INDICACAO|AMIGO|INDIQUEI)\b/, 'MEDIUM'],
  ['TRIAL_REQUEST', /\b(TESTE|TESTAR|DEMONSTRACAO|EXPERIMENTAR)\b/, 'HIGH'],
  ['NEW_CUSTOMER', /\b(QUERO ASSINAR|NOVA ASSINATURA|AINDA NAO SOU CLIENTE|COMO CONTRATAR)\b/, 'HIGH'],
  ['SUPPORT_REQUEST', /\b(NAO (ESTA|TA) FUNCIONANDO|SEM SINAL|TRAVANDO|TRAVOU|ERRO|PROBLEMA|NAO ABRE|NAO CONECTA|ACESSO VENCEU)\b/, 'HIGH'],
  ['EXPIRATION_QUERY', /\b(QUAL|QUANDO|DATA|VER|CONSULTAR)? ?(E |E O |O )?(MEU )?VENCIMENTO\b|\bQUANDO VENCE\b|\bVALIDADE\b/, 'HIGH'],
  ['PAYMENT_EVIDENCE', /\b(PAGUEI|FIZ O PIX|ENVIEI O COMPROVANTE|SEGUE O COMPROVANTE|COMPROVANTE)\b/, 'HIGH'],
  ['PAYMENT_STATUS', /\b(PAGAMENTO|PIX|BOLETO|CARTAO)\b.*\b(CAIU|CONFIRMADO|APROVADO|IDENTIFICADO|STATUS)\b|\bJA CAIU\b/, 'HIGH'],
  ['RENEWAL_STATUS', /\b(JA RENOVOU|FOI RENOVAD[OA]|STATUS DA RENOVACAO|RENOVACAO.*(STATUS|CONCLUIDA|PROCESSANDO))\b/, 'HIGH'],
  ['PAYMENT_METHODS_QUERY', /^7$|\b(FORMAS|MEIOS|METODOS|OPCOES) (DE )?PAGAMENTO\b|\b(COMO (POSSO |FACO PARA )?PAGAR|ACEITA[MR]?|POSSO PAGAR|DA PARA PAGAR|PODE PAGAR|PARCELA[MR]?|PARCELAMENTO)\b|\b(TEM|PODE SER|E POSSIVEL)\b.*\b(PIX|BOLETO|CARTAO)\b|\b(PIX|BOLETO|CARTAO) OU (PIX|BOLETO|CARTAO)\b/, 'HIGH'],
  ['PAYMENT_REQUEST', /\b(MANDA|MANDE|ENVIA|ENVIE|GERA|GERE|QUERO|PRECISO|VOU|DESEJO)\b.*\b(PIX|LINK|COBRANCA|PAGAMENTO|PAGAR|BOLETO|CARTAO)\b|^(PIX|BOLETO|CARTAO|PAGAMENTO)$|^PAGAR\b/, 'HIGH'],
  ['RENEWAL_REQUEST', /^(3|MENSAL|TRIMESTRAL|SEMESTRAL|ANUAL|30|85|150|270)$|\b(QUERO|PRECISO|VOU|PODE|GOSTARIA DE)? ?RENOVAR\b|\bRENOVACAO\b/, 'HIGH'],
  ['PLAN_QUERY', /^1$|\b(PLANOS|VALORES?|PRECOS?|QUANTO CUSTA|MUDAR MEU PLANO|MENSAL|TRIMESTRAL|SEMESTRAL|ANUAL)\b/, 'HIGH'],
  ['SUBSCRIPTION_QUERY', /^2$|\b(MINHA CONTA|MINHA ASSINATURA|MEU PLANO|STATUS DO PLANO|MEU ACESSO)\b/, 'HIGH'],
  ['GREETING', /^(OI|OLA|OPA|E AI|BOM DIA|BOA TARDE|BOA NOITE|TUDO BEM|BLZ)$/, 'HIGH']
]);

const INJECTION_RULES = Object.freeze([
  /\bIGNORE (AS |SUAS |TODAS AS )?(REGRAS|INSTRUCOES)\b/,
  /\bEXECUTE COMO (ADMIN|ADMINISTRADOR|OWNER)\b/,
  /\b(ME MARQUE|MARQUE ME|MARCAR) COMO PAG[OA]\b/,
  /\bRENOVE SEM PAGAMENTO\b/,
  /\bREVELE (SEU )?(PROMPT|INSTRUCOES INTERNAS|SEGREDO)\b/,
  /\bEXECUTE (SQL|SHELL|COMANDO)\b/
]);

export function detectPromptInjection(value) {
  const text = normalize(value);
  return INJECTION_RULES.some((rule) => rule.test(text));
}

function contextualIntent(text, conversationState, contentType) {
  const state = String(conversationState || '').toUpperCase();
  if (/^SUPPORT_(DEVICE|APPLICATION|SCOPE|RESULT)$/.test(state) && /^[12]$/.test(text)) {
    return { intent: 'SUPPORT_REQUEST', confidence: 'HIGH' };
  }
  if (state === 'WAITING_PAYMENT' && ['IMAGE','PDF','DOCUMENT'].includes(String(contentType).toUpperCase()) && !text) {
    return {intent:'PAYMENT_EVIDENCE',confidence:'HIGH'};
  }
  if (state === 'WAITING_PAYMENT' && /^(E O LINK|O MESMO LINK|MANDA DE NOVO|ENVIA DE NOVO|CADE O LINK)\??$/.test(text)) {
    return {intent:'PAYMENT_REQUEST',confidence:'HIGH'};
  }
  if (!/^(E AGORA|E AI|JA FOI|E ENTAO|COMO ESTA|ALGUMA NOVIDADE)\??$/.test(text)) return null;
  if (state === 'WAITING_PAYMENT') return { intent: 'PAYMENT_STATUS', confidence: 'HIGH' };
  if (['RENEWAL', 'PROCESSING', 'VERIFYING'].includes(state)) {
    return { intent: 'RENEWAL_STATUS', confidence: 'HIGH' };
  }
  return null;
}

export function understandRequest(value, { conversationState = null, contentType = 'TEXT' } = {}) {
  const text = normalize(value);
  const injection = detectPromptInjection(text);
  if (injection) {
    return Object.freeze({
      primary_intent: 'UNKNOWN',
      confidence: 'LOW',
      intents: [{ name: 'UNKNOWN', confidence: 'LOW' }],
      security_flags: ['PROMPT_INJECTION'],
      content_type: String(contentType || 'TEXT').toUpperCase()
    });
  }

  if (['IMAGE', 'PDF', 'DOCUMENT'].includes(String(contentType || '').toUpperCase()) &&
      /COMPROVANTE|PAGAMENTO|PIX/.test(text) && !RULES.slice(0,3).some(([,rule]) => rule.test(text))) {
    return Object.freeze({
      primary_intent: 'PAYMENT_EVIDENCE',
      confidence: 'HIGH',
      intents: [{ name: 'PAYMENT_EVIDENCE', confidence: 'HIGH' }],
      security_flags: [],
      content_type: String(contentType).toUpperCase()
    });
  }

  const contextual = contextualIntent(text, conversationState, contentType);
  if (contextual) {
    return Object.freeze({
      primary_intent: contextual.intent,
      confidence: contextual.confidence,
      intents: [{ name: contextual.intent, confidence: contextual.confidence }],
      security_flags: [],
      content_type: String(contentType || 'TEXT').toUpperCase()
    });
  }

  const found = [];
  const financialRefusal = /\b(NAO|NUNCA|SEM)\b.{0,35}\b(MANDE|MANDA|ENVIE|ENVIA|GERE|GERA|QUERO|RENOVAR|RENOVACAO|COBRANCA|PIX|PAGAMENTO|PAGAR|BOLETO|CARTAO)\b/.test(text);
  const financialExplanation = /\b(COMO FUNCIONA|O QUE E|SO (QUERO )?(SABER|ENTENDER)|EXPLIQUE|EXPLICAR|QUANTO CUSTA|QUAL (O )?(VALOR|PRECO))\b/.test(text) || RULES.find(([name]) => name === 'PAYMENT_METHODS_QUERY')[1].test(text) || PLAN_CHOICES.filter(([, pattern]) => pattern.test(text)).length > 1;
  for (const [name, rule, confidence] of RULES) {
    if (['PAYMENT_REQUEST', 'RENEWAL_REQUEST'].includes(name) && (financialRefusal || financialExplanation)) continue;
    if (rule.test(text) && !found.some((item) => item.name === name)) {
      found.push({ name, confidence });
    }
  }

  if (detectRequestedPlan(text) && !financialExplanation && !financialRefusal && (!found.length || found[0].name === 'PLAN_QUERY')) {
    found.unshift({ name: 'RENEWAL_REQUEST', confidence: 'HIGH' });
  }

  // "Paguei e já renovou?" precisa consultar os dois estados, sem transformar
  // evidência declarada pelo cliente em confirmação financeira.
  if (found.some((item) => item.name === 'PAYMENT_EVIDENCE') && /JA RENOVOU|FOI RENOVAD/.test(text)) {
    if (!found.some((item) => item.name === 'RENEWAL_STATUS')) {
      found.push({ name: 'RENEWAL_STATUS', confidence: 'HIGH' });
    }
  }

  if (!found.length && /^SUPPORT_(DEVICE|APPLICATION|SCOPE|RESULT)$/.test(String(conversationState || '').toUpperCase()) && text) {
    found.push({ name: 'SUPPORT_REQUEST', confidence: 'HIGH' });
  }
  const intents = found.length ? found : [{ name: 'UNKNOWN', confidence: 'LOW' }];
  return Object.freeze({
    primary_intent: intents[0].name,
    confidence: intents[0].confidence,
    intents,
    security_flags: [],
    content_type: String(contentType || 'TEXT').toUpperCase()
  });
}
