const FRESH_MS = 24 * 60 * 60 * 1000;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

function instant(value) {
  if (!(typeof value === 'string' || typeof value === 'number' || value instanceof Date)) return null;
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function publicHostname(hostname) {
  if (!hostname.includes('.') || hostname.length > 253 || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test|example|lan|home)$/.test(hostname)) return false;
  return hostname.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
}

function dnsOrigin(value) {
  // A missing scheme must not be guessed. Provider addresses remain copy-only data.
  if (typeof value !== 'string' || value.length > 350 ||
      !/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?\/?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !publicHostname(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) return null;
    return url.origin;
  } catch { return null; }
}

function noticeSource(value) {
  if (typeof value !== 'string' || !/^https:\/\/bitpanel\.vip\/notices\/?$/.test(value)) return null;
  return 'https://bitpanel.vip/notices';
}

function credential(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || UNSAFE_TEXT.test(value)) return false;
  // URLSearchParams replaces lone surrogates; reject them rather than changing credentials.
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

// Invoke only with the result of the authenticated customer's guarded access.reveal().
// This pure formatter neither establishes ownership nor fetches, logs or persists a URL.
// The provider's generic /notices instructions confirm get.php with these four fields.
export function buildCustomerPlaylist({ help, access, now = new Date() } = {}) {
  const today = instant(now);
  if (!today || access?.expiresInSeconds !== 60 || !credential(access?.username, 128) ||
      !credential(access?.password, 512) || !Array.isArray(help?.dns)) return null;
  const current = help.dns.filter(item => item?.status === 'current');
  if (!current.length || current.length > 12) return null;
  const verified = [];
  for (const item of current) {
    const date = instant(item.verifiedAt), origin = dnsOrigin(item.value), sourceUrl = noticeSource(item.sourceUrl);
    if (!date || !origin || !sourceUrl || today - date < 0 || today - date > FRESH_MS) return null;
    verified.push({ origin, date, sourceUrl });
  }
  // Several conflicting current addresses do not identify the customer's correct server.
  if (new Set(verified.map(item => item.origin)).size !== 1) return null;
  const selected = verified.reduce((latest, item) => item.date > latest.date ? item : latest);
  const url = new URL('/get.php', selected.origin);
  url.search = new URLSearchParams({ username: access.username, password: access.password,
    type: 'm3u_plus', output: 'ts' }).toString();
  return { url: url.href, expiresInSeconds: 60, containsPassword: true,
    dnsVerifiedAt: selected.date.toISOString(), sourceUrl: selected.sourceUrl };
}
