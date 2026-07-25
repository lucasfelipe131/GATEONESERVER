import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits;
  throw new Error('WhatsApp inválido. Use DDD + número.');
}

export function maskPhone(value) {
  const phone = String(value || '');
  if (phone.length < 8) return '••••••••';
  return `${phone.slice(0, 4)}•••••${phone.slice(-4)}`;
}

export function sanitizeForLog(value) {
  if (!value || typeof value !== 'object') return value;
  const blocked = /token|password|secret|pix|authorization/i;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      blocked.test(key) ? '[PROTEGIDO]' : typeof item === 'object' ? sanitizeForLog(item) : item
    ])
  );
}
