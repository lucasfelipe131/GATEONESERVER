import assert from 'node:assert/strict';
import test from 'node:test';
import { operationalMetric, PHASE4_METRICS } from '../src/core/operational-metrics.js';

test('métricas preparatórias usam catálogo e descartam identificadores sensíveis', () => {
  assert.equal(Object.keys(PHASE4_METRICS).length, 8);
  assert.deepEqual(operationalMetric(
    PHASE4_METRICS.RENEWAL_PROCESSING_TIME_MS,
    1200,
    { provider: 'fake', state: 'COMPLETED', customer_id: 'não-exportar' }
  ), {
    name: 'gate_renewal_processing_time_ms',
    value: 1200,
    labels: { provider: 'fake', state: 'COMPLETED' }
  });
});
