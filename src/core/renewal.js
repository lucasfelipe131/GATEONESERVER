export function renewalExecutionDecision({
  coreStatus,
  legacyStatus,
  paymentStatus,
  approvedAt,
  requiresApproval
}) {
  if (coreStatus === 'COMPLETED' || legacyStatus === 'completed') {
    return { allowed: false, duplicate: true, code: 'RENEWAL_ALREADY_COMPLETED' };
  }
  if (!['paid', 'CONFIRMED'].includes(paymentStatus)) {
    return { allowed: false, duplicate: false, code: 'PAYMENT_NOT_CONFIRMED' };
  }
  if (requiresApproval && !approvedAt) {
    return { allowed: false, duplicate: false, code: 'HUMAN_ACTION_REQUIRED' };
  }
  return { allowed: true, duplicate: false, code: null };
}
