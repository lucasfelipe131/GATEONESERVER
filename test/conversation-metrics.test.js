import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autonomousRenewalRate,
  autonomousResolutionRate,
  phase5Metric,
  PHASE5_METRICS
} from '../src/core/conversation-metrics.js';

test('métricas do agente não exportam customer, mensagem ou conteúdo', () => {
  assert.equal(Object.keys(PHASE5_METRICS).length, 14);
  assert.deepEqual(phase5Metric(
    PHASE5_METRICS.TOOL_SUCCESS_TOTAL,
    1,
    { tool: 'getExpiration', result: 'SUCCESS', customer_id: 'não-exportar', message: 'não-exportar' }
  ), {
    name: 'gate_agent_tool_success_total',
    value: 1,
    labels: { tool: 'getExpiration', result: 'SUCCESS' }
  });
});

test('KPIs formalizam apenas operações elegíveis', () => {
  assert.deepEqual(autonomousResolutionRate({ resolved: 7, eligible: 10 }), {
    resolved: 7, eligible: 10, rate: 0.7
  });
  assert.deepEqual(autonomousRenewalRate({ completed: 3, eligibleStarted: 4 }), {
    resolved: 3, eligible: 4, rate: 0.75
  });
  assert.throws(() => autonomousResolutionRate({ resolved: 2, eligible: 1 }));
});
