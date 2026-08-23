export const PHASE4_METRICS = Object.freeze({
  PAYMENT_CONFIRMATION_LATENCY_MS: 'gate_payment_confirmation_latency_ms',
  RENEWAL_PROCESSING_TIME_MS: 'gate_renewal_processing_time_ms',
  RENEWAL_SUCCESS_TOTAL: 'gate_renewal_success_total',
  RENEWAL_FAILURE_TOTAL: 'gate_renewal_failure_total',
  DUPLICATE_PREVENTED_TOTAL: 'gate_duplicate_prevented_total',
  RETRY_TOTAL: 'gate_operational_retry_total',
  HUMAN_ACTION_REQUIRED_TOTAL: 'gate_human_action_required_total',
  RECONCILIATION_DIVERGENCE_TOTAL: 'gate_reconciliation_divergence_total'
});

export function operationalMetric(name, value, labels = {}) {
  if (!Object.values(PHASE4_METRICS).includes(name)) throw new Error('Métrica operacional desconhecida.');
  if (!Number.isFinite(value) || value < 0) throw new Error('Valor de métrica inválido.');
  const safeLabels = Object.fromEntries(
    Object.entries(labels).filter(([key]) => [
      'provider', 'state', 'result', 'failure_class', 'operation'
    ].includes(key))
  );
  return { name, value, labels: safeLabels };
}
