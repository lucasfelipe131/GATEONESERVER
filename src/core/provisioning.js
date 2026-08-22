export const PROVISIONING_OPERATIONS = Object.freeze([
  'LOOKUP',
  'CREATE',
  'RENEW',
  'GET_EXPIRATION',
  'GET_STATUS'
]);

export class ProvisioningProvider {
  constructor(providerName) {
    if (new.target === ProvisioningProvider) {
      throw new Error('ProvisioningProvider é um contrato abstrato.');
    }
    this.providerName = providerName;
  }

  lookupAccount() { throw new Error('lookupAccount() não implementado.'); }
  createAccount() { throw new Error('createAccount() não implementado.'); }
  renewAccount() { throw new Error('renewAccount() não implementado.'); }
  getExpiration() { throw new Error('getExpiration() não implementado.'); }
  getStatus() { throw new Error('getStatus() não implementado.'); }
}

export function provisioningResult({ status, data = null, reason = null }) {
  if (!['COMPLETED', 'FAILED', 'HUMAN_ACTION_REQUIRED'].includes(status)) {
    throw new Error(`Resultado de provisioning inválido: ${status}`);
  }
  return { status, data, reason };
}
