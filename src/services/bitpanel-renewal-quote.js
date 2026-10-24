const normalized = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u00a0/g, ' ');

function field(text, label) {
  const prefix = new RegExp(`^${label}\\s*:`, 'i');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => prefix.test(line));
  return lines.length === 1 ? lines[0].replace(prefix, '').trim() : null;
}

function numberAfter(text, label) {
  const raw = field(text, label);
  if (!/^[1-9]\d*$/.test(raw || '')) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function moneyAfter(text, label) {
  const match = (field(text, label) || '').match(/^R\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})$/);
  const value = match ? Number(match[1].replace(/\./g, '').replace(',', '')) : null;
  return Number.isSafeInteger(value) ? value : null;
}

export function parseBitPanelRenewalQuote(text) {
  const clean = normalized(text);
  const headers = clean.split(/\r?\n/).map(line => line.trim()).filter(line => /^Renovar lista\b/i.test(line));
  const listId = headers.length === 1 ? headers[0].match(/^Renovar lista\s+#([1-9]\d{0,19})\.?$/i)?.[1] ?? null : null;
  return {
    listId,
    planLabel: field(clean, 'Plano'),
    months: numberAfter(clean, 'Quantidade de meses'),
    connections: numberAfter(clean, 'Total de conexoes'),
    credits: numberAfter(clean, 'Total em creditos'),
    unitPriceCents: moneyAfter(clean, 'Valor da unidade'),
    totalPriceCents: moneyAfter(clean, 'Valor total')
  };
}

export function validateBitPanelRenewalQuote(text, renewal, policy) {
  if (renewal?.automatic_renewal !== true) return null;
  const quote = parseBitPanelRenewalQuote(text);
  const mapping = policy?.plans?.[renewal.plan_code];
  const positive = value => Number.isSafeInteger(value) && value > 0;
  if (policy?.enabled !== true || !mapping || !positive(policy.maxConnections) ||
      !positive(policy.unitPriceCents) || !positive(policy.maxCreditsPerRenewal) ||
      !positive(renewal.expected_credit_cost) ||
      typeof policy.planLabel !== 'string' || !policy.planLabel.trim() ||
      quote.listId !== String(renewal.bitpanel_list_id || '') ||
      quote.planLabel !== policy.planLabel ||
      quote.months !== renewal.duration_months || quote.months !== mapping.durationMonths ||
      !positive(quote.connections) || quote.connections > policy.maxConnections ||
      quote.credits !== renewal.expected_credit_cost || quote.credits !== mapping.creditCost ||
      quote.credits > policy.maxCreditsPerRenewal ||
      quote.unitPriceCents !== policy.unitPriceCents ||
      !positive(quote.totalPriceCents) ||
      !positive(quote.unitPriceCents * quote.months * quote.connections) ||
      quote.totalPriceCents !== quote.unitPriceCents * quote.months * quote.connections) {
    throw new Error('RENEWAL_PROVIDER_QUOTE_MISMATCH');
  }
  return quote;
}
