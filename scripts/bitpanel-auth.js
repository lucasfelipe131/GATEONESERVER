import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const TIMEOUT_MS = 30 * 60_000;
const fail = code => Object.assign(new Error(code), { code });
const SAFE_ERRORS = new Set(['BITPANEL_AUTH_ARGUMENTS_INVALID', 'BITPANEL_AUTH_BASE_URL_INVALID',
  'BITPANEL_AUTH_TIMEOUT', 'BITPANEL_AUTH_BROWSER_CLOSED', 'BITPANEL_AUTH_SESSION_NOT_READY',
  'BITPANEL_AUTH_SESSION_WRITE_FAILED', 'BITPANEL_AUTH_UNAVAILABLE']);
export const safeBitPanelAuthError = error => SAFE_ERRORS.has(error?.code) ? error.code : 'BITPANEL_AUTH_UNAVAILABLE';

export function bitPanelAuthOrigin(value = 'https://bitpanel.vip') {
  let url;
  try { url = new URL(value); } catch { throw fail('BITPANEL_AUTH_BASE_URL_INVALID'); }
  if (url.protocol !== 'https:' || !['bitpanel.vip', 'www.bitpanel.vip'].includes(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw fail('BITPANEL_AUTH_BASE_URL_INVALID');
  return url.origin;
}

export function parseBitPanelAuthArgs(args) {
  let outputPath, automatic = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--auto') {
      if (automatic) throw fail('BITPANEL_AUTH_ARGUMENTS_INVALID');
      automatic = true;
    } else if (value === '--output') {
      if (outputPath || !args[index + 1] || args[index + 1].startsWith('--')) throw fail('BITPANEL_AUTH_ARGUMENTS_INVALID');
      outputPath = args[++index];
    } else if (!value.startsWith('-') && !outputPath) outputPath = value;
    else throw fail('BITPANEL_AUTH_ARGUMENTS_INVALID');
  }
  return { outputPath: resolve(outputPath || 'bitpanel-session.json') };
}

export function bitPanelListHeadersReady(headers) {
  if (!Array.isArray(headers) || headers.length > 100 || headers.some(value => typeof value !== 'string' || value.length > 200)) return false;
  const names = headers.map(value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase());
  return [/^(?:#\s*)?(?:id|codigo)$|^#$/, /^(?:proprietario|revendedor|owner|reseller)$/, /^(?:usuario|login|username|user name)$/]
    .every(pattern => names.filter(name => pattern.test(name)).length === 1);
}

/** Classify only generic page state; never inspect customer rows, credentials or CAPTCHA contents. */
export function bitPanelHumanAuthState({ url, baseUrl = 'https://bitpanel.vip', tableProtectedReady = false,
  loginVisible = false, captchaVisible = false } = {}) {
  const origin = bitPanelAuthOrigin(baseUrl);
  let current;
  try { current = new URL(url); } catch { return 'IGNORED'; }
  if (current.origin !== origin || current.username || current.password) return 'IGNORED';
  if (/\/login(?:\/|$)/i.test(current.pathname) || loginVisible || captchaVisible) return 'WAITING';
  if (['/list', '/list/'].includes(current.pathname) && tableProtectedReady) return 'READY';
  return current.pathname === '/' ? 'OPEN_LIST' : 'WAITING';
}

async function genericPageState(page, baseUrl) {
  if (page.isClosed()) return 'IGNORED';
  const observedUrl = page.url();
  if (bitPanelHumanAuthState({ url: observedUrl, baseUrl }) === 'IGNORED') return 'IGNORED';
  const visible = async selector => {
    const candidates = page.locator(selector), count = await candidates.count();
    if (count > 100) return true;
    for (let index = 0; index < count; index++)
      if (await candidates.nth(index).isVisible().catch(() => false)) return true;
    return false;
  };
  const [tableVisible, loginVisible, captchaVisible] = await Promise.all([
    visible('table tbody'),
    visible("input[type='password'], input[autocomplete='current-password']"),
    visible("[data-sitekey], iframe[src*='challenges.cloudflare.com'], iframe[src*='recaptcha']")
  ]);
  let tableProtectedReady = false;
  if (tableVisible && ['/list', '/list/'].includes(new URL(observedUrl).pathname)) {
    const headers = page.locator('table thead th'), count = await headers.count(), names = [];
    if (count <= 100) for (let index = 0; index < count; index++) {
      const header = headers.nth(index);
      if (await header.isVisible().catch(() => false)) names.push(await header.innerText());
    }
    tableProtectedReady = count <= 100 && bitPanelListHeadersReady(names);
  }
  if (page.url() !== observedUrl) return 'WAITING';
  return bitPanelHumanAuthState({ url: observedUrl, baseUrl, tableProtectedReady, loginVisible, captchaVisible });
}

/** The caller owns cleanup. Navigation is read-only; all authentication stays with the human. */
export async function waitForHumanBitPanelSession(context, { baseUrl = 'https://bitpanel.vip', timeoutMs = TIMEOUT_MS,
  now = () => Date.now(), sleep = ms => new Promise(done => setTimeout(done, ms)), emit = () => {}, cancelled = () => false } = {}) {
  const origin = bitPanelAuthOrigin(baseUrl);
  const deadline = now() + Math.max(1, Math.min(TIMEOUT_MS, timeoutMs));
  const tracked = new Map();let closed = false;
  const onClose = () => { closed = true; };
  context.on('close', onClose);
  try {
    while (now() < deadline) {
      if (closed || cancelled()) throw fail('BITPANEL_AUTH_BROWSER_CLOSED');
      const pages = context.pages().filter(page => !page.isClosed());
      if (!pages.length) throw fail('BITPANEL_AUTH_BROWSER_CLOSED');
      const states = await Promise.all(pages.map(async page => ({ page, state: await genericPageState(page, origin).catch(() => 'WAITING') })));
      for (const { page, state } of states) {
        const previous = tracked.get(page) || { rootSince: null, rootAttempted: false, readyChecks: 0 };
        const observation = { ...previous, readyChecks: state === 'READY' ? previous.readyChecks + 1 : 0 };
        if (observation.readyChecks >= 2) return page;
        if (state === 'OPEN_LIST') {
          observation.rootSince ??= now();
          if (!observation.rootAttempted && now() - observation.rootSince >= 1_500) {
            observation.rootAttempted = true;emit('BITPANEL_AUTH_OPENING_LIST');
            // Commit finishes before DOM/load completion. A timeout still leaves the DOM observable.
            void page.goto(`${origin}/list`, { waitUntil: 'commit', timeout: Math.min(10_000, Math.max(1, deadline - now())) })
              .catch(() => { if (!closed) emit('BITPANEL_AUTH_NAVIGATION_RETRY'); });
          }
        } else { observation.rootSince = null;observation.rootAttempted = false; }
        tracked.set(page, observation);
      }
      await sleep(Math.min(250, Math.max(1, deadline - now())));
    }
    throw fail('BITPANEL_AUTH_TIMEOUT');
  } finally { context.off('close', onClose); }
}

function ownStorageState(state, origin) {
  const hostname = new URL(origin).hostname;
  if (!Array.isArray(state?.cookies) || !Array.isArray(state?.origins)) throw fail('BITPANEL_AUTH_SESSION_NOT_READY');
  const cookies = state.cookies.filter(cookie => {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    return ['bitpanel.vip', 'www.bitpanel.vip'].includes(domain) && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
  const origins = state.origins.filter(item => item.origin === origin);
  if (!cookies.some(cookie => typeof cookie.value === 'string' && cookie.value.length) &&
      !origins.some(item => Array.isArray(item.localStorage) && item.localStorage.some(entry => typeof entry.value === 'string' && entry.value.length)))
    throw fail('BITPANEL_AUTH_SESSION_NOT_READY');
  return { cookies, origins };
}

async function saveStorageState(state, outputPath) {
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await rename(temporary, outputPath);
  } catch { throw fail('BITPANEL_AUTH_SESSION_WRITE_FAILED'); }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Returns only a status code. Browser/session contents never appear in output or errors. */
export async function captureHumanBitPanelSession({ baseUrl = 'https://bitpanel.vip', outputPath = resolve('bitpanel-session.json'),
  profilePath = resolve('data/bitpanel-auth'), launch = options => chromium.launchPersistentContext(profilePath, options),
  ensureProfile = () => mkdir(profilePath, { recursive: true }), save = saveStorageState, emit = () => {},
  timeoutMs = TIMEOUT_MS, now = () => Date.now(), sleep, cancelled = () => false } = {}) {
  const origin = bitPanelAuthOrigin(baseUrl);
  let context;
  try {
    await ensureProfile();
    context = await launch({ headless: false, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', timeout: 30_000 });
    const page = context.pages().find(candidate => !candidate.isClosed()) || await context.newPage();
    emit('BITPANEL_AUTH_WAITING_FOR_HUMAN');
    // Do not await load/network-idle, and never fill a field or click a login/CAPTCHA control.
    void page.goto(`${origin}/list`, { waitUntil: 'commit', timeout: 10_000 })
      .catch(() => emit('BITPANEL_AUTH_NAVIGATION_RETRY'));
    const authenticated = await waitForHumanBitPanelSession(context, { baseUrl: origin, timeoutMs, now, sleep, emit, cancelled });
    if (cancelled()) throw fail('BITPANEL_AUTH_BROWSER_CLOSED');
    if (await genericPageState(authenticated, origin) !== 'READY') throw fail('BITPANEL_AUTH_SESSION_NOT_READY');
    const state = ownStorageState(await context.storageState(), origin);
    if (cancelled()) throw fail('BITPANEL_AUTH_BROWSER_CLOSED');
    if (await genericPageState(authenticated, origin) !== 'READY') throw fail('BITPANEL_AUTH_SESSION_NOT_READY');
    await save(state, outputPath);
    emit('BITPANEL_AUTH_SESSION_SAVED');
    return { code: 'BITPANEL_AUTH_SESSION_SAVED' };
  } catch (error) { throw fail(safeBitPanelAuthError(error)); }
  finally { if (context) await context.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);process.once('SIGTERM', stop);
  try {
    const options = parseBitPanelAuthArgs(process.argv.slice(2));
    await captureHumanBitPanelSession({ ...options, baseUrl: process.env.BITPANEL_BASE_URL || 'https://bitpanel.vip',
      cancelled: () => stopped, emit: code => process.stdout.write(`${code}\n`) });
  } catch (error) { process.stdout.write(`${safeBitPanelAuthError(error)}\n`);process.exitCode = 1; }
  finally { process.off('SIGINT', stop);process.off('SIGTERM', stop); }
}
