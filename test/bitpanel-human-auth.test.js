import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bitPanelAuthOrigin, bitPanelHumanAuthState, bitPanelListHeadersReady, bitPanelLinesHeadersReady, captureHumanBitPanelSession,
  parseBitPanelAuthArgs, safeBitPanelAuthError, waitForHumanBitPanelSession } from '../scripts/bitpanel-auth.js';

const origin = 'https://bitpanel.vip';
const privateValue = 'synthetic-private-cookie-and-password';
function pageFixture({ url = `${origin}/login`, table = false, headers = ['ID', 'Usuário', 'Proprietário'], login = false,
  loginButton = false, captcha = false, captchaControl = false, navigation = [], tableCount = 1, navigate } = {}) {
  const state = { url, table, headers, login, loginButton, captcha, captchaControl, navigation, tableCount, closed: false }, calls = { navigation: [], fieldActions: 0, contents: 0, headerReads: 0 };
  const page = {
    url: () => state.url, isClosed: () => state.closed,
    goto: async (next, options) => { calls.navigation.push({ url: next, options });if (navigate) return navigate(next, state); },
    locator: selector => {
      if (selector === 'table thead th') return { count: async () => state.headers.length, nth: index => ({
        isVisible: async () => state.headers[index]?.visible !== false,
        innerText: async () => { calls.headerReads++;return typeof state.headers[index] === 'string' ? state.headers[index] : state.headers[index].text; }
      }) };
      if (selector === 'table') return { count: async () => state.tableCount };
      if (selector === "input[name='cf-turnstile-response'],input[name='g-recaptcha-response']") return { count: async () => state.captchaControl ? 1 : 0 };
      const visibility = () => selector === 'table tbody' ? state.table : selector.includes("input[type='password']") ? state.login :
        selector.startsWith('a[href=') ? state.navigation.some(path => selector.includes(`a[href='${path}']`)) : state.captcha;
      const values = () => Array.isArray(visibility()) ? visibility() : [visibility()];
      return { count: async () => values().length, nth: index => ({ isVisible: async () => Boolean(values()[index]),
        fill: async () => { calls.fieldActions++;assert.fail('human-only helper cannot fill'); },
        click: async () => { calls.fieldActions++;assert.fail('human-only helper cannot click'); },
        innerText: async () => { calls.contents++;assert.fail('customer content cannot be read'); } }) };
    },
    getByRole: () => ({ count: async () => 1, nth: () => ({ isVisible: async () => state.loginButton }) }),
    waitForLoadState: async () => assert.fail('page readiness cannot require full load/network-idle'),
    waitForURL: async () => assert.fail('page readiness cannot wait only on the first tab URL')
  };
  return { page, state, calls };
}
function contextFixture(initialPages = []) {
  const pages = [...initialPages], listeners = new Map(), calls = { close: 0, storage: 0, newPage: 0 };
  const context = {
    pages: () => pages,
    on: (name, handler) => { listeners.set(name, handler); },
    off: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); },
    close: async () => { calls.close++;listeners.get('close')?.(); },
    newPage: async () => { calls.newPage++;const { page } = pageFixture();pages.push(page);return page; },
    storageState: async () => { calls.storage++;return { cookies: [
      { domain: '.bitpanel.vip', name: 'synthetic_session', value: privateValue, path: '/', expires: -1 },
      { domain: 'outside.invalid', name: 'unrelated', value: 'outside-private-value', path: '/' }
    ], origins: [{ origin, localStorage: [{ name: 'synthetic', value: privateValue }] },
      { origin: 'https://outside.invalid', localStorage: [{ name: 'other', value: 'outside-private-value' }] }] }; }
  };
  return { context, pages, listeners, calls };
}
function clockFixture(onSleep = () => {}) {
  let time = 0;
  return { now: () => time, sleep: async duration => { time += duration;await onSleep(time); } };
}

test('page states require the protected list and verified headers, while login, CAPTCHA and other origins remain waiting', () => {
  assert.equal(bitPanelHumanAuthState({ url: `${origin}/list`, tableProtectedReady: true }), 'READY');
  assert.equal(bitPanelHumanAuthState({ url: `${origin}/lines`, linesProtectedReady: true }), 'READY');
  for (const url of [`${origin}/lines?filter=all`, `${origin}/lines#tab`, `${origin}/lines/`])
    assert.equal(bitPanelHumanAuthState({ url, linesProtectedReady: true }), 'WAITING');
  assert.equal(bitPanelHumanAuthState({ url: `${origin}/list/?private-query=${privateValue}`, tableProtectedReady: true }), 'READY');
  assert.equal(bitPanelHumanAuthState({ url: `${origin}/list`, tableVisible: true }), 'WAITING');
  assert.equal(bitPanelHumanAuthState({ url: origin }), 'OPEN_LIST');
  for (const state of [{ url: `${origin}/login`, tableProtectedReady: true }, { url: `${origin}/auth/login`, tableProtectedReady: true },
    { url: `${origin}/auth/recovery`, tableProtectedReady: true }, { url: origin, loginVisible: true },
    { url: origin, captchaVisible: true }, { url: `${origin}/list` }, { url: `${origin}/list/view/12345`, tableProtectedReady: true }])
    assert.equal(bitPanelHumanAuthState(state), 'WAITING');
  for (const url of ['about:blank', 'https://outside.invalid/list', `https://user:${privateValue}@bitpanel.vip/list`])
    assert.equal(bitPanelHumanAuthState({ url, tableProtectedReady: true }), 'IGNORED');
  for (const baseUrl of ['http://bitpanel.vip', 'https://outside.invalid', `${origin}/login`, `${origin}/?token=${privateValue}`, 'https://bitpanel.vip:8443'])
    assert.throws(() => bitPanelAuthOrigin(baseUrl), { code: 'BITPANEL_AUTH_BASE_URL_INVALID' });
});

test('protected list headers require one visible ID, owner and username column and reject incomplete or duplicate labels', () => {
  for (const headers of [['#', 'Usuário', 'Proprietário'], ['Código', 'Login', 'Revendedor'], [' # ID ', 'Validade', 'Login', 'Owner'],
    ['ID', 'Username', 'Owner'], ['ID', 'User name', 'Reseller'], [' # ID ', ' USER   NAME ', ' RESELLER ']])
    assert.equal(bitPanelListHeadersReady(headers), true);
  for (const headers of [[], ['ID', 'Usuário'], ['ID', 'Usuário', 'Proprietário', 'Login'], ['ID', 'Usuário', 'Owner', 'Proprietário'],
    ['ID', 'ID', 'Usuário', 'Owner'], ['Other', 'Usuário', 'Owner'], ['ID', 'Usuário', 'Other'],
    ['ID', 'Username'], ['Username', 'Owner'], ['ID', 'Username', 'User name', 'Owner'],
    ['ID', 'Username', 'Owner', 'Reseller'], ['ID', 'User', 'Owner'], null])
    assert.equal(bitPanelListHeadersReady(headers), false);
});

test('new English protected list captures only after unique ID, owner and username headers', async () => {
  for (const headers of [['ID', 'Username', 'Owner'], ['ID', 'User name', 'Reseller']]) {
    const f = pageFixture({ url: `${origin}/list`, table: true, headers }), { context, calls } = contextFixture([f.page]), clock = clockFixture();let saves = 0;
    const result = await captureHumanBitPanelSession({ ...clock, timeoutMs: 2_000, ensureProfile: async () => {}, launch: async () => context,
      save: async () => { saves++;assert.ok(clock.now() >= 250); } });
    assert.equal(result.code, 'BITPANEL_AUTH_SESSION_SAVED');assert.equal(saves, 1);assert.equal(calls.storage, 1);
    assert.equal(calls.close, 1);assert.equal(f.calls.fieldActions, 0);assert.equal(f.calls.contents, 0);
  }
});

const currentLinesHeaders = ['Estado', 'Usuário', 'Senha', 'País', 'Telas', 'Status', 'Validade', 'Criação', 'Ações'];
const currentLinesNavigation = ['/lines', '/dashboard', '/finance'];
test('the observed lines header vocabulary requires seven unique semantic groups', () => {
  assert.equal(bitPanelLinesHeadersReady(currentLinesHeaders), true);
  assert.equal(bitPanelLinesHeadersReady(['State', 'Username', 'Password', 'Screens', 'Status', 'Expires', 'Actions']), true);
  for (const headers of [[], currentLinesHeaders.filter(value => value !== 'Senha'), [...currentLinesHeaders, 'Username'],
    [...currentLinesHeaders, 'Estado'], currentLinesHeaders.map(value => value === 'Validade' ? 'Other' : value)])
    assert.equal(bitPanelLinesHeadersReady(headers), false);
});

test('the current canonical lines page captures after two observations with its own navigation and no row reads', async () => {
  const f = pageFixture({ url: `${origin}/lines`, table: true, headers: currentLinesHeaders, navigation: currentLinesNavigation });
  const { context, calls } = contextFixture([f.page]), clock = clockFixture();let saves = 0;
  const result = await captureHumanBitPanelSession({ ...clock, timeoutMs: 2_000, ensureProfile: async () => {}, launch: async () => context,
    save: async () => { saves++;assert.ok(clock.now() >= 250); } });
  assert.equal(result.code, 'BITPANEL_AUTH_SESSION_SAVED');assert.equal(saves, 1);assert.equal(calls.storage, 1);
  assert.equal(f.calls.navigation[0].url, `${origin}/lines`);assert.equal(f.calls.contents, 0);assert.equal(f.calls.fieldActions, 0);
});

test('lines capture rejects missing own navigation, duplicate or missing headers, login, hidden Turnstile, multiple tables and foreign sources', async () => {
  for (const patch of [{ navigation: ['/lines', '/dashboard'] }, { navigation: ['https://outside.invalid/lines', '/dashboard', '/finance'] },
    { headers: currentLinesHeaders.filter(value => value !== 'Senha') }, { headers: [...currentLinesHeaders, 'Usuário'] },
    { login: true }, { loginButton: true }, { captcha: true }, { captchaControl: true }, { tableCount: 2 },
    { url: `${origin}/lines?filter=all` }, { url: `${origin}/lines#tab` }, { url: 'https://outside.invalid/lines' }]) {
    const f = pageFixture({ url: `${origin}/lines`, table: true, headers: currentLinesHeaders, navigation: currentLinesNavigation, ...patch });
    const { context, calls } = contextFixture([f.page]), clock = clockFixture();let saves = 0;
    await assert.rejects(captureHumanBitPanelSession({ ...clock, timeoutMs: 1_000, ensureProfile: async () => {}, launch: async () => context,
      save: async () => { saves++; } }), { code: 'BITPANEL_AUTH_TIMEOUT' });
    assert.equal(saves, 0);assert.equal(calls.storage, 0);assert.equal(f.calls.contents, 0);assert.equal(f.calls.fieldActions, 0);
  }
});

test('new login route, password or CAPTCHA cannot capture an English table scaffold', async () => {
  for (const options of [{ url: `${origin}/auth/login` }, { url: `${origin}/auth/recovery` },
    { url: `${origin}/list`, login: true }, { url: `${origin}/list`, captcha: true }, { url: 'https://outside.invalid/list' }]) {
    const f = pageFixture({ table: true, headers: ['ID', 'Username', 'Owner'], ...options }), { context, calls } = contextFixture([f.page]), clock = clockFixture();let saves = 0;
    await assert.rejects(captureHumanBitPanelSession({ ...clock, timeoutMs: 1_000, ensureProfile: async () => {}, launch: async () => context,
      save: async () => { saves++; } }), { code: 'BITPANEL_AUTH_TIMEOUT' });
    assert.equal(saves, 0);assert.equal(calls.storage, 0);assert.equal(calls.close, 1);assert.equal(f.calls.fieldActions, 0);assert.equal(f.calls.contents, 0);
  }
});

test('a source change during public header reads cannot release session capture', async () => {
  const f = pageFixture({ url: `${origin}/list`, table: true, headers: ['ID', 'Username', 'Owner'] });
  const originalLocator = f.page.locator;
  f.page.locator = selector => {
    const locator = originalLocator(selector);if (selector !== 'table thead th') return locator;
    return { ...locator, nth: index => { const header = locator.nth(index);return { ...header, innerText: async () => {
      const text = await header.innerText();f.state.url = `${origin}/auth/login`;return text;
    } }; } };
  };
  const { context, calls } = contextFixture([f.page]), clock = clockFixture();let saves = 0;
  await assert.rejects(captureHumanBitPanelSession({ ...clock, timeoutMs: 1_000, ensureProfile: async () => {}, launch: async () => context,
    save: async () => { saves++; } }), { code: 'BITPANEL_AUTH_TIMEOUT' });
  assert.equal(saves, 0);assert.equal(calls.storage, 0);assert.equal(f.calls.fieldActions, 0);assert.equal(f.calls.contents, 0);
});

test('a visible empty scaffold or hidden/missing/duplicate generic headers cannot capture or overwrite a session', async () => {
  for (const headers of [[], ['ID', 'Usuário'], ['ID', 'Usuário', 'Owner', 'Login'],
    ['ID', 'Usuário', { text: 'Proprietário', visible: false }]]) {
    const f = pageFixture({ url: `${origin}/list`, table: true, headers }), { context, calls } = contextFixture([f.page]), clock = clockFixture();let saves = 0;
    await assert.rejects(captureHumanBitPanelSession({ ...clock, timeoutMs: 1_000, ensureProfile: async () => {}, launch: async () => context,
      save: async () => { saves++;assert.fail('incomplete list cannot save a session'); } }), { code: 'BITPANEL_AUTH_TIMEOUT' });
    assert.equal(saves, 0);assert.equal(calls.storage, 0);assert.equal(calls.close, 1);assert.equal(f.calls.contents, 0);assert.equal(f.calls.fieldActions, 0);
  }
});

test('headers arriving asynchronously release capture only after complete visible metadata and two ready checks', async () => {
  const f = pageFixture({ url: `${origin}/list`, table: true, headers: [] }), { context, calls } = contextFixture([f.page]);let saves = 0;
  const clock = clockFixture(time => { if (time === 500) f.state.headers = ['ID', 'Usuário', 'Proprietário']; });
  const result = await captureHumanBitPanelSession({ ...clock, timeoutMs: 2_000, ensureProfile: async () => {}, launch: async () => context,
    save: async () => { saves++;assert.ok(clock.now() >= 750); } });
  assert.equal(result.code, 'BITPANEL_AUTH_SESSION_SAVED');assert.equal(saves, 1);assert.equal(calls.storage, 1);assert.equal(calls.close, 1);
  assert.ok(f.calls.headerReads >= 6);assert.equal(f.calls.contents, 0);assert.equal(f.calls.fieldActions, 0);
});

test('all existing and newly opened tabs are observed instead of waiting on the original login tab', async () => {
  const first = pageFixture(), later = pageFixture({ url: `${origin}/list`, table: true });
  const { context, pages, listeners } = contextFixture([first.page]);
  const clock = clockFixture(time => { if (time === 250) pages.push(later.page); });
  assert.equal(await waitForHumanBitPanelSession(context, { ...clock, timeoutMs: 2_000 }), later.page);
  assert.equal(first.calls.navigation.length, 0);assert.equal(later.calls.navigation.length, 0);
  assert.equal(listeners.size, 0);assert.equal(first.calls.fieldActions, 0);assert.equal(later.calls.contents, 0);
});

test('a stable provider homepage opens the protected list and visible DOM succeeds even while navigation never finishes', async () => {
  const f = pageFixture({ url: origin, navigate: (_url, state) => { state.url = `${origin}/list`;state.table = true;return new Promise(() => {}); } });
  const { context } = contextFixture([f.page]), clock = clockFixture();
  assert.equal(await waitForHumanBitPanelSession(context, { ...clock, timeoutMs: 5_000 }), f.page);
  assert.equal(f.calls.navigation.length, 1);assert.equal(f.calls.navigation[0].url, `${origin}/lines`);
  assert.equal(f.calls.navigation[0].options.waitUntil, 'commit');assert.equal(f.calls.contents, 0);assert.equal(f.calls.fieldActions, 0);
});

test('visible login or CAPTCHA on a homepage cannot trigger navigation or saving, including a hidden first password field', async () => {
  for (const options of [{ login: true }, { login: [false, true] }, { captcha: true }]) {
    const f = pageFixture({ url: origin, ...options }), { context } = contextFixture([f.page]), clock = clockFixture();
    await assert.rejects(waitForHumanBitPanelSession(context, { ...clock, timeoutMs: 2_000 }), { code: 'BITPANEL_AUTH_TIMEOUT' });
    assert.equal(f.calls.navigation.length, 0);assert.equal(f.calls.fieldActions, 0);assert.equal(f.calls.contents, 0);
  }
});

test('the human wait defaults to thirty minutes and stops safely when the browser is closed or cancelled', async () => {
  const f = pageFixture(), fixture = contextFixture([f.page]);let time = 0;
  await assert.rejects(waitForHumanBitPanelSession(fixture.context, { now: () => time, sleep: async () => { time += 60_000; } }), { code: 'BITPANEL_AUTH_TIMEOUT' });
  assert.equal(time, 30 * 60_000);assert.equal(fixture.listeners.size, 0);
  for (const kind of ['closed', 'cancelled', 'no-pages']) {
    const current = contextFixture(kind === 'no-pages' ? [] : [f.page]), clock = clockFixture(() => current.listeners.get('close')?.());
    await assert.rejects(waitForHumanBitPanelSession(current.context, { ...clock, timeoutMs: 2_000, cancelled: () => kind === 'cancelled' }), { code: 'BITPANEL_AUTH_BROWSER_CLOSED' });
    assert.equal(current.listeners.size, 0);
  }
});

test('capture saves only provider storage after repeated visible proof, closes the context, and emits only fixed codes', async () => {
  const f = pageFixture({ navigate: (_url, state) => { state.url = `${origin}/list`;state.table = true; } });
  const { context, calls } = contextFixture([f.page]), clock = clockFixture(), emitted = [], saves = [];
  const result = await captureHumanBitPanelSession({ ...clock, timeoutMs: 2_000, ensureProfile: async () => {},
    launch: async options => { assert.equal(options.headless, false);return context; },
    outputPath: 'synthetic-session.json', save: async (state, path) => saves.push({ state, path }), emit: code => emitted.push(code) });
  assert.deepEqual(result, { code: 'BITPANEL_AUTH_SESSION_SAVED' });assert.equal(saves.length, 1);assert.equal(calls.close, 1);assert.equal(calls.storage, 1);
  assert.equal(saves[0].path, 'synthetic-session.json');assert.equal(saves[0].state.cookies.length, 1);assert.equal(saves[0].state.origins.length, 1);
  assert.equal(JSON.stringify(saves[0].state).includes('outside-private-value'), false);
  assert.ok(emitted.every(code => /^BITPANEL_AUTH_[A-Z_]+$/.test(code)));
  assert.equal(JSON.stringify({ emitted, result }).includes(privateValue), false);assert.equal(f.calls.fieldActions, 0);assert.equal(f.calls.contents, 0);
});

test('capture never saves after a redirect or empty provider storage and always closes on timeout or sanitized failure', async () => {
  for (const kind of ['timeout', 'redirect', 'headers-changed', 'empty-storage', 'write-failure', 'storage-failure']) {
    const f = pageFixture({ navigate: (_url, state) => { if (kind !== 'timeout') { state.url = `${origin}/list`;state.table = true; } } });
    const { context, calls } = contextFixture([f.page]), clock = clockFixture(), emitted = [];let saves = 0;
    if (kind === 'redirect') context.storageState = async () => { f.state.url = `${origin}/login`;return { cookies: [], origins: [] }; };
    if (kind === 'headers-changed') {
      const originalStorageState = context.storageState;
      context.storageState = async () => { const state = await originalStorageState();f.state.headers = [];return state; };
    }
    if (kind === 'empty-storage') context.storageState = async () => ({ cookies: [], origins: [] });
    if (kind === 'storage-failure') context.storageState = async () => { throw Error(`${privateValue} https://bitpanel.vip/?token=${privateValue}`); };
    const code = kind === 'timeout' ? 'BITPANEL_AUTH_TIMEOUT' : ['redirect', 'headers-changed', 'empty-storage'].includes(kind) ? 'BITPANEL_AUTH_SESSION_NOT_READY' : 'BITPANEL_AUTH_UNAVAILABLE';
    await assert.rejects(captureHumanBitPanelSession({ ...clock, timeoutMs: 1_000, ensureProfile: async () => {}, launch: async () => context,
      save: async () => { saves++;if (kind === 'write-failure') throw Error(privateValue); }, emit: item => emitted.push(item) }), error => {
      assert.equal(error.code, code);assert.equal(error.message, code);assert.equal(JSON.stringify(error).includes(privateValue), false);return true;
    });
    assert.equal(calls.close, 1);assert.equal(saves, kind === 'write-failure' ? 1 : 0);assert.equal(emitted.includes('BITPANEL_AUTH_SESSION_SAVED'), false);
    assert.equal(JSON.stringify(emitted).includes(privateValue), false);assert.equal(f.calls.fieldActions, 0);
  }
});

test('CLI paths and legacy auto flags are parsed in either order without treating auto as a session filename', () => {
  assert.deepEqual(parseBitPanelAuthArgs(['--auto']), { outputPath: resolve('bitpanel-session.json') });
  for (const args of [['synthetic.json', '--auto'], ['--auto', 'synthetic.json'], ['--auto', '--output', 'synthetic.json']])
    assert.deepEqual(parseBitPanelAuthArgs(args), { outputPath: resolve('synthetic.json') });
  for (const args of [['--unknown'], ['--auto', '--auto'], ['a.json', 'b.json'], ['--output'], ['--output', '--auto']])
    assert.throws(() => parseBitPanelAuthArgs(args), { code: 'BITPANEL_AUTH_ARGUMENTS_INVALID' });
  assert.equal(safeBitPanelAuthError({ code: privateValue, message: privateValue }), 'BITPANEL_AUTH_UNAVAILABLE');
});
