export const CONVERSATION_INTENTS = Object.freeze([
  'GREETING',
  'RENEWAL_REQUEST',
  'PAYMENT_REQUEST',
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
  ['PAYMENT_STATUS', /\b(PAGAMENTO|PIX)\b.*\b(CAIU|CONFIRMADO|APROVADO|IDENTIFICADO|STATUS)\b|\bJA CAIU\b/, 'HIGH'],
  ['RENEWAL_STATUS', /\b(JA RENOVOU|FOI RENOVAD[OA]|STATUS DA RENOVACAO|RENOVACAO.*(STATUS|CONCLUIDA|PROCESSANDO))\b/, 'HIGH'],
  ['PAYMENT_REQUEST', /\b(MANDA|ENVIA|GERA|QUERO|PRECISO)\b.*\b(PIX|LINK|COBRANCA|PAGAMENTO)\b|\bPIX\b/, 'HIGH'],
  ['RENEWAL_REQUEST', /^3$|\b(QUERO|PRECISO|VOU|PODE|GOSTARIA DE)? ?RENOVAR\b|\bRENOVACAO\b/, 'HIGH'],
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
  const financialRefusal = /\b(NAO|NUNCA|SEM)\b.{0,35}\b(MANDE|MANDA|ENVIE|ENVIA|GERE|GERA|QUERO|RENOVAR|RENOVACAO|COBRANCA|PIX|PAGAMENTO)\b/.test(text);
  const financialExplanation = /\b(COMO FUNCIONA|O QUE E|SO (QUERO )?(SABER|ENTENDER)|EXPLIQUE|EXPLICAR)\b/.test(text);
  for (const [name, rule, confidence] of RULES) {
    if (['PAYMENT_REQUEST', 'RENEWAL_REQUEST'].includes(name) && (financialRefusal || financialExplanation)) continue;
    if (rule.test(text) && !found.some((item) => item.name === name)) {
      found.push({ name, confidence });
    }
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
