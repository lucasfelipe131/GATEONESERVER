import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerPlaylist } from '../src/services/customer-playlist.js';
import { buildCustomerHelp } from '../src/services/customer-help-content.js';

const now = '2026-10-12T22:00:00.000Z';
const verifiedAt = '2026-10-12T21:00:00.000Z';
const access = { username: 'synthetic-user', password: 'synthetic-password', expiresInSeconds: 60 };
const dns = extra => ({ name: 'Servidor sintético', value: 'http://stream.gatecustomer.com',
  status: 'current', verifiedAt, sourceUrl: 'https://bitpanel.vip/notices', ...extra });
const build = (items = [dns()], reveal = access, time = now) =>
  buildCustomerPlaylist({ help: { dns: items }, access: reveal, now: time });

test('M3U uses the provider-proven format and preserves the verified scheme and port without network calls', () => {
  const result = build();
  assert.deepEqual(result, { url: 'http://stream.gatecustomer.com/get.php?username=synthetic-user&password=synthetic-password&type=m3u_plus&output=ts',
    expiresInSeconds: 60, containsPassword: true, dnsVerifiedAt: verifiedAt, sourceUrl: 'https://bitpanel.vip/notices' });
  assert.equal(build([dns({ value: 'https://stream.gatecustomer.com:8443/' })]).url,
    'https://stream.gatecustomer.com:8443/get.php?username=synthetic-user&password=synthetic-password&type=m3u_plus&output=ts');
  const help = buildCustomerHelp({ catalog: { dns: [dns({ status: 'READY' })] }, now });
  assert.equal(buildCustomerPlaylist({ help, access, now }).url, result.url);
  assert.equal(JSON.stringify(help).includes('synthetic-password'), false);
  assert.equal(JSON.stringify(help).includes('get.php'), false);
});

test('reserved characters and Unicode credentials are encoded once as opaque values', () => {
  const reveal = { ...access, username: 'nome+á&=' , password: ' &+=?#%/"💡 senha ' };
  const result = build([dns()], reveal), url = new URL(result.url);
  assert.equal(url.pathname, '/get.php');assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams.keys()], ['username', 'password', 'type', 'output']);
  assert.equal(url.searchParams.get('username'), reveal.username);
  assert.equal(url.searchParams.get('password'), reveal.password);
  assert.equal(url.searchParams.get('type'), 'm3u_plus');assert.equal(url.searchParams.get('output'), 'ts');
  assert.equal(result.url.includes('💡'), false);assert.equal(result.url.includes(' senha '), false);
});

test('freshness and state come from the sanitized help DNS, never a stale fallback', () => {
  const boundary = '2026-10-11T22:00:00.000Z';
  assert.ok(build([dns({ verifiedAt: boundary })]));
  for (const extra of [{ verifiedAt: '2026-10-11T21:59:59.999Z' }, { verifiedAt: '2026-10-12T22:00:00.001Z' },
    { verifiedAt: null }, { verifiedAt: 'invalid' }, { verifiedAt: true }, { verifiedAt: '' },
    { status: 'stale' }, { status: 'READY' }, { status: 'REAUTH_REQUIRED' }, { status: 'verified' }, { status: undefined }])
    assert.equal(build([dns(extra)]), null);
  assert.equal(build([]), null);assert.equal(buildCustomerPlaylist({ help: {}, access, now }), null);
  for (const time of ['invalid', null, false]) assert.equal(build([dns()], access, time), null);
  assert.ok(build([dns(), dns({ status: 'stale', value: 'http://old.gatecustomer.com' })]));
  const help = buildCustomerHelp({ catalog: { dns: [dns({ status: 'READY' })], bitpanelSync: { status: 'REAUTH_REQUIRED' } }, now });
  assert.equal(buildCustomerPlaylist({ help, access, now }), null);
});

test('only the authenticated BitPanel notices provenance is accepted', () => {
  for (const sourceUrl of [null, 'http://bitpanel.vip/notices', 'https://bitpanel.vip/', 'https://bitpanel.vip/news',
    'https://bitpanel.vip.notices.evil.net/notices', 'https://other.net/notices',
    'https://user:secret@bitpanel.vip/notices', 'https://bitpanel.vip/notices?token=private',
    'https://bitpanel.vip/notices#fragment', 'https://bitpanel.vip:8443/notices', 'javascript:alert(1)'])
    assert.equal(build([dns({ sourceUrl })]), null);
  assert.ok(build([dns({ sourceUrl: 'https://bitpanel.vip/notices/' })]));
});

test('DNS cannot contain hidden credentials, a path, query, local address or an invented protocol', () => {
  for (const value of ['stream.gatecustomer.com', 'stream.gatecustomer.com:8080', 'ftp://stream.gatecustomer.com',
    'javascript:alert(1)', 'data:text/plain,secret', 'http://user:secret@stream.gatecustomer.com',
    'http://stream.gatecustomer.com/get.php', 'http://stream.gatecustomer.com/../', 'http://stream.gatecustomer.com/%2e/',
    'http://stream.gatecustomer.com?password=private', 'http://stream.gatecustomer.com?',
    'http://stream.gatecustomer.com#fragment', 'http://stream.gatecustomer.com#',
    'http://stream.gatecustomer.com\\@other.net', 'http://stream.gatecustomer.com\n', ' http://stream.gatecustomer.com',
    'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://[::1]', 'http://localhost',
    'http://device.local', 'http://device.internal', 'http://device.test', 'http://device.example',
    'http://device.home', 'http://stream.gatecustomer.com:0', 'http://stream.gatecustomer.com:65536'])
    assert.equal(build([dns({ value })]), null);
});

test('malformed reveals return null and error details never contain credentials', () => {
  for (const reveal of [null, {}, { ...access, expiresInSeconds: 120 }, { ...access, expiresInSeconds: '60' },
    { ...access, username: '' }, { ...access, username: ' ' }, { ...access, password: null }, { ...access, password: ' ' },
    { ...access, username: 'a'.repeat(129) }, { ...access, password: 'a'.repeat(513) },
    { ...access, password: 'secret\nvalue' }, { ...access, username: 'user\0value' },
    { ...access, password: 'secret\u202evalue' }, { ...access, password: '\ud800' }, { ...access, password: '\udc00' }])
    assert.equal(build([dns()], reveal), null);
  assert.equal(buildCustomerPlaylist(), null);
});

test('ambiguous current servers fail closed, equivalent entries are deterministic and input is unchanged', () => {
  assert.equal(build([dns(), dns({ value: 'http://different.gatecustomer.com' })]), null);
  assert.equal(build([dns(), dns({ value: 'https://stream.gatecustomer.com' })]), null);
  assert.equal(build([dns(), dns({ value: 'http://stream.gatecustomer.com', verifiedAt: null })]), null);
  const items = [dns({ value: 'http://STREAM.gatecustomer.com:80/', verifiedAt: '2026-10-12T20:00:00.000Z' }), dns()];
  const input = structuredClone({ help: { dns: items }, access, now });
  const before = structuredClone(input), result = buildCustomerPlaylist(input);
  assert.equal(result.dnsVerifiedAt, verifiedAt);assert.deepEqual(input, before);
  assert.deepEqual(buildCustomerPlaylist(input), result);
  assert.deepEqual(Object.keys(result).sort(), ['containsPassword', 'dnsVerifiedAt', 'expiresInSeconds', 'sourceUrl', 'url']);
});
