export const PROVISIONING_PROVIDER_RESULTS = Object.freeze([
  'SUCCESS',
  'NOT_FOUND',
  'AUTH_REQUIRED',
  'HUMAN_ACTION_REQUIRED',
  'TEMPORARY_FAILURE',
  'PERMANENT_FAILURE',
  'UNKNOWN'
]);

export function normalizeProvisioningResult(result) {
  if (!PROVISIONING_PROVIDER_RESULTS.includes(result?.status)) {
    throw new Error(`Resultado de provisioning inválido: ${result?.status}`);
  }
  return {
    status: result.status,
    provider_reference: result.provider_reference || null,
    expiration: result.expiration || null,
    reason: result.reason || null,
    evidence: result.evidence || null
  };
}

export function provisioningDecision(result) {
  const normalized = normalizeProvisioningResult(result);
  if (normalized.status === 'SUCCESS') return { next: 'VERIFYING', retry: false };
  if (normalized.status === 'TEMPORARY_FAILURE') return { next: 'RETRY_SCHEDULED', retry: true };
  if (['AUTH_REQUIRED', 'HUMAN_ACTION_REQUIRED'].includes(normalized.status)) {
    return { next: 'HUMAN_ACTION_REQUIRED', retry: false };
  }
  return { next: 'FAILED', retry: false };
}

export function verifyExpiration({ previousExpiration, expectedExpiration, providerExpiration }) {
  if (!previousExpiration || !expectedExpiration || !providerExpiration) {
    return {
      verified: false,
      code: 'EXPIRATION_EVIDENCE_INCOMPLETE',
      expected_expiration: expectedExpiration || null,
      provider_expiration: providerExpiration || null
    };
  }
  if (providerExpiration !== expectedExpiration) {
    return {
      verified: false,
      code: 'EXPIRATION_MISMATCH',
      expected_expiration: expectedExpiration,
      provider_expiration: providerExpiration
    };
  }
  if (providerExpiration <= previousExpiration) {
    return { verified: false, code: 'EXPIRATION_NOT_EXTENDED' };
  }
  return {
    verified: true,
    code: null,
    expected_expiration: expectedExpiration,
    provider_expiration: providerExpiration
  };
}

export class FakeProvisioningProvider {
  constructor(script = {}) {
    this.providerName = 'fake';
    this.script = script;
    this.calls = [];
  }

  async lookupAccount(input) { return this.#run('lookupAccount', input); }
  async getStatus(input) { return this.#run('getStatus', input); }
  async getExpiration(input) { return this.#run('getExpiration', input); }
  async renewAccount(input) { return this.#run('renewAccount', input); }

  async #run(operation, input) {
    this.calls.push({ operation, input });
    const configured = this.script[operation];
    if (configured instanceof Error) throw configured;
    if (typeof configured === 'function') return configured(input);
    return configured || { status: 'SUCCESS' };
  }
}
