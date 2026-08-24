export const PHASE5_METRICS = Object.freeze({
  INTENT_RECOGNITION_TOTAL: 'gate_agent_intent_recognition_total',
  UNKNOWN_INTENT_TOTAL: 'gate_agent_unknown_intent_total',
  TOOL_SUCCESS_TOTAL: 'gate_agent_tool_success_total',
  POLICY_DENIAL_TOTAL: 'gate_agent_policy_denial_total',
  AUTONOMOUS_RESOLUTION_TOTAL: 'gate_agent_autonomous_resolution_total',
  HUMAN_HANDOFF_TOTAL: 'gate_agent_human_handoff_total',
  REPEATED_QUESTION_TOTAL: 'gate_agent_repeated_question_total',
  DUPLICATE_PREVENTED_TOTAL: 'gate_agent_duplicate_prevented_total',
  TURNS_PER_RESOLUTION: 'gate_agent_turns_per_resolution',
  AGENT_FAILURE_TOTAL: 'gate_agent_failure_total',
  TOOL_FAILURE_TOTAL: 'gate_agent_tool_failure_total',
  PROVIDER_FAILURE_TOTAL: 'gate_agent_provider_failure_total',
  HUMAN_REQUIRED_TOTAL: 'gate_agent_human_required_total',
  RESPONSE_VALIDATION_FAILURE_TOTAL: 'gate_agent_response_validation_failure_total'
});

export function phase5Metric(name, value, labels = {}) {
  if (!Object.values(PHASE5_METRICS).includes(name)) throw new Error('Métrica do agente desconhecida.');
  if (!Number.isFinite(value) || value < 0) throw new Error('Valor de métrica inválido.');
  const safe = new Set(['intent', 'confidence', 'tool', 'policy', 'result', 'failure_class', 'channel']);
  return {
    name,
    value,
    labels: Object.fromEntries(Object.entries(labels).filter(([key]) => safe.has(key)))
  };
}

export function autonomousResolutionRate({ resolved, eligible }) {
  if (!Number.isInteger(resolved) || !Number.isInteger(eligible) || resolved < 0 || eligible < 0) {
    throw new Error('Contadores de autonomia inválidos.');
  }
  if (resolved > eligible) throw new Error('Resoluções não podem exceder solicitações elegíveis.');
  return { resolved, eligible, rate: eligible ? resolved / eligible : null };
}

export function autonomousRenewalRate({ completed, eligibleStarted }) {
  return autonomousResolutionRate({ resolved: completed, eligible: eligibleStarted });
}
