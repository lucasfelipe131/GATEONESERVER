import {
  IDENTITY_RESOLUTION_STATUSES,
  IDENTITY_TYPES
} from './contracts.js';

export function normalizeExternalIdentity(type, value) {
  if (!IDENTITY_TYPES.includes(type)) throw new Error(`Tipo de identidade inválido: ${type}`);
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Identidade externa vazia.');
  if (type === 'WHATSAPP' || type === 'PHONE') return raw.replace(/\D/g, '');
  if (type === 'EMAIL' || type === 'LOGIN') return raw.toLocaleLowerCase('pt-BR');
  return raw;
}

export function identityResolution(customerIds) {
  const unique = [...new Set(customerIds.filter(Boolean))];
  if (unique.length === 1) {
    return { status: IDENTITY_RESOLUTION_STATUSES[0], customer_id: unique[0] };
  }
  if (unique.length > 1) {
    return {
      status: IDENTITY_RESOLUTION_STATUSES[1],
      customer_id: null,
      candidate_count: unique.length
    };
  }
  return { status: IDENTITY_RESOLUTION_STATUSES[2], customer_id: null };
}

export function resolveCustomerIdentity(candidates, identity) {
  const type = String(identity?.type || '').toUpperCase();
  const normalized = normalizeExternalIdentity(type, identity?.value);
  const provider = String(identity?.provider || 'core').trim().toLowerCase();
  const matches = candidates
    .filter((candidate) => candidate.identity_type === type)
    .filter((candidate) => String(candidate.provider || 'core').toLowerCase() === provider)
    .filter((candidate) => normalizeExternalIdentity(type, candidate.external_id) === normalized)
    .map((candidate) => candidate.customer_id);
  return identityResolution(matches);
}
