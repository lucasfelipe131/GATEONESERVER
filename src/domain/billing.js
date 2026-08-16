const STAGES = new Map([
  [3, 'd-3'],
  [0, 'd0'],
  [-2, 'd+2'],
  [-5, 'd+5']
]);

export function formatMoney(cents) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(cents / 100);
}

export function formatDate(dateOnly) {
  const [year, month, day] = String(dateOnly).slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

export function dateOnlyInTimezone(date = new Date(), timezone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function daysBetween(dateOnly, todayOnly) {
  const day = Date.parse(`${String(dateOnly).slice(0, 10)}T12:00:00Z`);
  const today = Date.parse(`${String(todayOnly).slice(0, 10)}T12:00:00Z`);
  return Math.round((day - today) / 86_400_000);
}

export function classifyStage(expiresOn, todayOnly) {
  return STAGES.get(daysBetween(expiresOn, todayOnly)) ?? null;
}

export function renderChargeMessage({ name, planName, expiresOn, amountCents, stage }) {
  const value = formatMoney(amountCents);
  const date = formatDate(expiresOn);
  const firstName = name.trim().split(/\s+/)[0];
  const templates = {
    'd-3': `Oi, ${firstName}! Seu plano ${planName} vence em ${date}. A renovação fica em ${value}; deixei o link seguro abaixo caso queira adiantar.`,
    d0: `Oi, ${firstName}! Passando para avisar que seu Gate One Pro vence hoje. A renovação fica em ${value}.`,
    'd+2': `Oi, ${firstName}! Seu plano venceu em ${date}. Se já pagou, pode desconsiderar; se ainda não, o link seguro continua abaixo. Valor: ${value}.`,
    'd+5': `Oi, ${firstName}! Seu acesso continua pendente desde ${date}. Quando quiser regularizar, a renovação fica em ${value}.`,
    new_sale: `Olá, ${firstName}! Você escolheu o plano ${planName}, no valor de ${value}. A cobrança Pix está pronta. Após a confirmação do pagamento, seu acesso será ativado automaticamente.`,
    manual: `Olá, ${firstName}! Preparamos sua renovação do plano ${planName}, no valor de ${value}.`
  };
  return templates[stage];
}

export function buildIdempotencyKey(subscriptionId, stage, dueOn) {
  return `${subscriptionId}:${stage}:${String(dueOn).slice(0, 10)}`;
}
