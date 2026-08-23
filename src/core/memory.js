import { randomUUID } from 'node:crypto';
import {
  MEMORY_CONFIDENCE,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  memoryRecordSchema
} from './contracts.js';
import { freshnessFor } from './customer-context.js';

const CONFIDENCE_RANK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3 });

const MEMORY_FRESHNESS_DOMAIN = Object.freeze({
  IDENTITY_FACT: 'identity',
  PREFERENCE: 'preference',
  RELATIONSHIP: 'relationship',
  SUPPORT_FACT: 'support_memory',
  COMMERCIAL_CONTEXT: 'commercial_memory',
  OPERATIONAL_NOTE: 'operational_memory'
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function containsSensitiveField(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveField);
  if (typeof value === 'string') {
    return /\b(?:password|senha|secret|token|cvv)\s*[:=]\s*\S+/i.test(value) ||
      /\bBearer\s+\S+/i.test(value) ||
      /\b(?:\d[ -]?){13,19}\b/.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) =>
    /(?:password|senha|secret|token|credential|card_number|cvv|pix_copy_paste)/i.test(key) ||
    containsSensitiveField(nested)
  );
}

export function memoryValuesEqual(left, right) {
  return canonical(left) === canonical(right);
}

export function normalizeMemoryInput(input, { now = new Date() } = {}) {
  const type = String(input?.type || '').trim().toUpperCase();
  const confidence = String(input?.confidence || '').trim().toUpperCase();
  if (!MEMORY_TYPES.includes(type)) throw new Error(`Tipo de memória inválido: ${type}`);
  if (!MEMORY_CONFIDENCE.includes(confidence)) {
    throw new Error(`Confiança de memória inválida: ${confidence}`);
  }
  const key = String(input?.key || '').trim().toLowerCase();
  if (!key || key.length > 200) throw new Error('A memória exige uma chave estável.');
  if (/(?:password|senha|secret|token|credential|card-number|cvv|pix-copy-paste)/i.test(key)) {
    throw new Error('Dados sensíveis não podem ser persistidos como memória de cliente.');
  }
  const source = String(input?.source || '').trim();
  if (!source || source.length > 100) throw new Error('A memória exige uma origem rastreável.');
  if (input?.value === undefined) throw new Error('A memória exige um valor explícito.');
  if (containsSensitiveField(input.value)) {
    throw new Error('Dados sensíveis não podem ser persistidos como memória de cliente.');
  }
  if (containsSensitiveField(String(input?.sourceReference || ''))) {
    throw new Error('A referência da memória não pode conter dados sensíveis.');
  }
  const observedAt = new Date(input?.observedAt || now);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('Data de observação inválida.');
  const validFrom = input?.validFrom ? new Date(input.validFrom) : null;
  const validUntil = input?.validUntil ? new Date(input.validUntil) : null;
  if (validFrom && !Number.isFinite(validFrom.getTime())) throw new Error('valid_from inválido.');
  if (validUntil && !Number.isFinite(validUntil.getTime())) throw new Error('valid_until inválido.');
  if (validFrom && validUntil && validUntil <= validFrom) {
    throw new Error('valid_until deve ser posterior a valid_from.');
  }
  return {
    memoryId: input.memoryId || randomUUID(),
    customerId: input.customerId,
    type,
    key,
    value: input.value,
    source,
    sourceReference: input.sourceReference ? String(input.sourceReference).slice(0, 500) : null,
    confidence,
    observedAt: observedAt.toISOString(),
    validFrom: validFrom?.toISOString() || null,
    validUntil: validUntil?.toISOString() || null
  };
}

export function decideMemoryConflict(existing, incoming) {
  if (!existing) return { action: 'CREATE', status: 'ACTIVE' };
  if (memoryValuesEqual(existing.value, incoming.value)) {
    return { action: 'DUPLICATE', status: existing.status };
  }
  const existingRank = CONFIDENCE_RANK[String(existing.confidence).toUpperCase()] || 0;
  const incomingRank = CONFIDENCE_RANK[String(incoming.confidence).toUpperCase()] || 0;
  if (incomingRank >= existingRank) {
    return {
      action: 'SUPERSEDE',
      status: 'ACTIVE',
      supersedes: existing.memory_id || existing.memoryId
    };
  }
  return {
    action: 'DISPUTE',
    status: 'DISPUTED',
    conflicts_with: existing.memory_id || existing.memoryId
  };
}

export function memoryFreshness(record, { now = new Date() } = {}) {
  if (record.status === 'DELETED') return 'STALE';
  if (record.status === 'EXPIRED') return 'STALE';
  return freshnessFor(
    MEMORY_FRESHNESS_DOMAIN[record.type || record.memory_type],
    record.observed_at || record.observedAt,
    { now, validUntil: record.valid_until || record.validUntil }
  );
}

export function selectRelevantMemories(rows, { limit = 6, now = new Date() } = {}) {
  const boundedLimit = Math.max(0, Math.min(Number(limit) || 0, 20));
  return rows
    .filter((row) => row.status === 'ACTIVE')
    .map((row) => ({ ...row, freshness: memoryFreshness(row, { now }) }))
    .filter((row) => row.freshness !== 'STALE')
    .sort((left, right) => {
      const confidence = (CONFIDENCE_RANK[right.confidence] || 0) -
        (CONFIDENCE_RANK[left.confidence] || 0);
      if (confidence) return confidence;
      return new Date(right.observed_at).getTime() - new Date(left.observed_at).getTime();
    })
    .slice(0, boundedLimit)
    .map((row) => memoryRecordSchema.parse({
      memory_id: row.memory_id,
      customer_id: row.customer_id,
      type: row.memory_type,
      key: row.memory_key,
      value: row.value,
      source: row.source,
      source_reference: row.source_reference || null,
      confidence: row.confidence,
      observed_at: new Date(row.observed_at).toISOString(),
      valid_from: row.valid_from ? new Date(row.valid_from).toISOString() : null,
      valid_until: row.valid_until ? new Date(row.valid_until).toISOString() : null,
      superseded_by: row.superseded_by || null,
      status: row.status,
      freshness: row.freshness
    }));
}

export function assertMemoryStatus(value) {
  if (!MEMORY_STATUSES.includes(value)) throw new Error(`Status de memória inválido: ${value}`);
  return value;
}
