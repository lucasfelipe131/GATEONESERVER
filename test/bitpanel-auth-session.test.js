import test from 'node:test';
import assert from 'node:assert/strict';
import { BITPANEL_LOGIN_SELECTORS, openBitPanelSession } from '../src/integrations/bitpanel.js';

const config = { BITPANEL_BASE_URL: 'https://bitpanel.vip', BITPANEL_LOGIN_URL: 'https://bitpanel.vip/login',
  BITPANEL_STORAGE_STATE: JSON.stringify({ cookies: [{ name: 'synthetic_session', value: 'synthetic', expires: 4102444800 }], origins: [] }),
  BITPANEL_USERNAME: 'synthetic-old-user', BITPANEL_PASSWORD: 'synthetic-old-password' };

function fixture({ unauthenticated = false, loginFormOnList = false, delayedLogin = false, table = true, external = false, captcha = false } = {}) {
  const calls = { urls: [], fills: [], submits: 0, tableProofs: 0 }; let currentUrl = '', submitted = false;
  const formVisible = () => !submitted && (currentUrl.includes('/login') || loginFormOnList);
  const page = {
    url: () => currentUrl,
    goto: async url => { calls.urls.push(url); currentUrl = external ? 'https://outside.invalid/list' :
      url.endsWith('/list') && unauthenticated ? 'https://bitpanel.vip/login' : url; },
    waitForURL: async predicate => { if (!predicate(new URL(currentUrl))) throw Error('not authenticated'); },
    locator: selector => {
      if (selector === 'table tbody') return { waitFor: async () => {
        calls.tableProofs++; if (delayedLogin) currentUrl = 'https://bitpanel.vip/login';
        if (!table || delayedLogin) throw Error('table unavailable');
      } };
      assert.ok(Object.values(BITPANEL_LOGIN_SELECTORS).includes(selector));
      const visible = () => formVisible() && !(captcha && selector === BITPANEL_LOGIN_SELECTORS.submit);
      const field = { isVisible: async () => visible(), fill: async () => { calls.fills.push(selector); },
        click: async () => { calls.submits++; submitted = true; currentUrl = 'https://bitpanel.vip/list'; } };
      return { count: async () => visible() ? 1 : 0, nth: () => field };
    }
  };
  return { page, calls };
}

test('a protected list with saved session is proved without opening login or filling stale credentials', async () => {
  const { page, calls } = fixture(); await openBitPanelSession(page, config);
  assert.deepEqual(calls.urls, ['https://bitpanel.vip/list']); assert.equal(calls.tableProofs, 1);
  assert.equal(calls.fills.length, 0); assert.equal(calls.submits, 0);
  const sessionOnly = fixture(); await openBitPanelSession(sessionOnly.page, { ...config, BITPANEL_USERNAME: '', BITPANEL_PASSWORD: '' });
  assert.equal(sessionOnly.calls.fills.length, 0); assert.equal(sessionOnly.calls.submits, 0);
});

test('saved sessions fall back to login only for an actual redirect or complete login form', async () => {
  for (const options of [{ unauthenticated: true }, { loginFormOnList: true }, { delayedLogin: true }]) {
    const { page, calls } = fixture(options); await openBitPanelSession(page, config);
    assert.deepEqual(calls.urls, ['https://bitpanel.vip/list', 'https://bitpanel.vip/login']);
    assert.equal(calls.fills.length, 2); assert.equal(calls.submits, 1);
  }
});

test('unavailable or redirected protected pages never authorize credential submission', async () => {
  for (const [options, code] of [[{ table: false }, 'BITPANEL_READ_UNAVAILABLE'], [{ external: true }, 'BITPANEL_READ_LINK_UNVERIFIED']]) {
    const { page, calls } = fixture(options); await assert.rejects(openBitPanelSession(page, config), { code });
    assert.equal(calls.fills.length, 0); assert.equal(calls.submits, 0);
  }
  const outside = fixture(); await assert.rejects(openBitPanelSession(outside.page, { ...config, BITPANEL_LOGIN_URL: 'https://outside.invalid/login' }), { code: 'BITPANEL_READ_LINK_UNVERIFIED' });
  assert.equal(outside.calls.urls.length, 0);
});

test('expired sessions without credentials or with CAPTCHA still require human authentication', async () => {
  for (const [options, settings] of [[{ unauthenticated: true }, { ...config, BITPANEL_USERNAME: '', BITPANEL_PASSWORD: '' }], [{ unauthenticated: true, captcha: true }, config]]) {
    const { page, calls } = fixture(options); await assert.rejects(openBitPanelSession(page, settings), /autenticação humana/);
    assert.equal(calls.fills.length, 0); assert.equal(calls.submits, 0);
  }
});

test('credential-only configuration keeps the existing login flow', async () => {
  const { page, calls } = fixture(); await openBitPanelSession(page, { ...config, BITPANEL_STORAGE_STATE: '' });
  assert.deepEqual(calls.urls, ['https://bitpanel.vip/login']); assert.equal(calls.fills.length, 2); assert.equal(calls.submits, 1); assert.equal(calls.tableProofs, 0);
});
