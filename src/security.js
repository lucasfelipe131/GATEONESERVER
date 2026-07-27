import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

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

function encryptionKey(secret) {
  return createHash('sha256').update(String(secret)).digest();
}

export function encryptSecret(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(payload, secret) {
  const [version, iv, tag, encrypted] = String(payload || '').split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Credencial protegida inválida.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    Buffer.from(iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

export function normalizePhone(value) {
  // Baileys may include a device suffix in a WhatsApp JID, for example
  // 5555999999999:12@s.whatsapp.net. It is not part of the phone number.
  const identity = String(value || '')
    .trim()
    .replace(/@.+$/i, '')
    .replace(/:\d+$/, '');
  let digits = identity.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    // WhatsApp may expose Brazilian mobile accounts without the ninth digit.
    // Normalize them to the same E.164 stored by spreadsheet imports while
    // preserving 8-digit landlines (subscriber prefixes 2-5).
    if (digits.length === 12 && /[6-9]/.test(digits[4])) {
      digits = `${digits.slice(0, 4)}9${digits.slice(4)}`;
    }
    return digits;
  }
  throw new Error('WhatsApp inválido. Use DDD + número.');
}

export function maskPhone(value) {
  const phone = String(value || '');
  if (phone.length < 8) return '••••••••';
  return `${phone.slice(0, 4)}•••••${phone.slice(-4)}`;
}

export function sanitizeForLog(value) {
  if (!value || typeof value !== 'object') return value;
  const blocked = /token|password|secret|pix|authorization|api[_-]?key|private[_-]?key/i;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      blocked.test(key) ? '[PROTEGIDO]' : typeof item === 'object' ? sanitizeForLog(item) : item
    ])
  );
}
