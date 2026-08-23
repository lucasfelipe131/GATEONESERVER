export const CAPABILITIES = Object.freeze({
  DASHBOARD_READ: 'dashboard.read',
  CATALOG_READ: 'catalog.read',
  CATALOG_SYNC: 'catalog.sync',
  CUSTOMER_READ: 'customer.read',
  CUSTOMER_WRITE: 'customer.write',
  CUSTOMER_STAGE_WRITE: 'customer.stage.write',
  CUSTOMER_PAYMENT_LINK_CREATE: 'customer.payment_link.create',
  CUSTOMER_PORTAL_LINK_CREATE: 'customer.portal_link.create',
  CUSTOMER_BULK_IMPORT: 'customer.bulk_import',
  CUSTOMER_BITPANEL_SYNC: 'customer.bitpanel_sync',
  CUSTOMER_DELETE: 'customer.delete',
  BILLING_READ: 'billing.read',
  BILLING_SCAN: 'billing.scan',
  BILLING_APPROVE: 'billing.approve',
  BILLING_MARK_PAID: 'billing.mark_paid',
  RENEWAL_READ: 'renewal.read',
  RENEWAL_APPROVE: 'renewal.approve',
  PROVISIONING_READ: 'provisioning.read',
  CRM_READ: 'crm.read',
  IDENTITY_READ: 'identity.read',
  IDENTITY_RESOLVE: 'identity.resolve',
  SETTINGS_READ: 'settings.read',
  SETTINGS_WRITE: 'settings.write',
  INTEGRATION_MANAGE: 'integration.manage',
  INTEGRATION_BITPANEL_SESSION: 'integration.bitpanel_session',
  INTEGRATION_PAYMENT_ACTIVATE: 'integration.payment_activate',
  AI_ADMIN_USE: 'ai.admin.use'
});

const OPERATOR_CAPABILITIES = new Set([
  CAPABILITIES.DASHBOARD_READ,
  CAPABILITIES.CATALOG_READ,
  CAPABILITIES.CUSTOMER_READ,
  CAPABILITIES.CUSTOMER_WRITE,
  CAPABILITIES.CUSTOMER_STAGE_WRITE,
  CAPABILITIES.CUSTOMER_PAYMENT_LINK_CREATE,
  CAPABILITIES.CUSTOMER_PORTAL_LINK_CREATE,
  CAPABILITIES.BILLING_READ,
  CAPABILITIES.RENEWAL_READ,
  CAPABILITIES.CRM_READ,
  CAPABILITIES.IDENTITY_READ,
  CAPABILITIES.SETTINGS_READ,
  CAPABILITIES.AI_ADMIN_USE
]);

const ALL_CAPABILITIES = new Set(Object.values(CAPABILITIES));

export function capabilitiesForRole(role) {
  if (role === 'admin') return new Set(ALL_CAPABILITIES);
  if (role === 'operator') return new Set(OPERATOR_CAPABILITIES);
  return new Set();
}

export function hasCapability(user, capability) {
  return Boolean(user?.role && capabilitiesForRole(user.role).has(capability));
}

export function isStepUpValid(session, capability, now = new Date()) {
  if (!session?.stepUpUntil) return false;
  if (!capability || session.stepUpCapability !== capability) return false;
  const expiresAt = new Date(session.stepUpUntil);
  return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
}

export function authorizationFailure(user, session, capability, { stepUp = false } = {}) {
  if (!hasCapability(user, capability)) {
    return { statusCode: 403, code: 'CAPABILITY_DENIED' };
  }
  if (stepUp && !isStepUpValid(session, capability)) {
    return { statusCode: 403, code: 'STEP_UP_REQUIRED' };
  }
  return null;
}

function firstForwardedValue(value) {
  return String(value || '').split(',')[0].trim();
}

export function expectedRequestOrigin(request, publicBaseUrl) {
  if (publicBaseUrl) return new URL(publicBaseUrl).origin;
  const protocol = firstForwardedValue(request.headers?.['x-forwarded-proto']) || request.protocol || 'http';
  const host = firstForwardedValue(request.headers?.['x-forwarded-host']) || request.headers?.host;
  if (!host) return null;
  return `${protocol}://${host}`;
}

export function isTrustedMutationOrigin(request, publicBaseUrl) {
  const fetchSite = String(request.headers?.['sec-fetch-site'] || '').toLowerCase();
  const originHeader = String(request.headers?.origin || '').trim();
  if (!originHeader) return fetchSite !== 'cross-site';
  if (originHeader === 'null') return false;
  try {
    const expected = expectedRequestOrigin(request, publicBaseUrl);
    return Boolean(expected && new URL(originHeader).origin === expected);
  } catch {
    return false;
  }
}
