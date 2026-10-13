import { parseBitPanelRenewalQuote, validateBitPanelRenewalQuote } from '../services/bitpanel-renewal-quote.js';
import { parseBitPanelPublishedDate } from './bitpanel-date.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

export const BITPANEL_LOGIN_SELECTORS = Object.freeze({
  username:
    "input[name='username'], input[name='email'], input[autocomplete='username']",
  password:
    "input[name='password'], input[type='password'], input[autocomplete='current-password']",
  submit: "button[type='submit']"
});

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

export function normalizeBitPanelText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isGateOneOwner(value) {
  const owner = normalizeBitPanelText(value).replace(/[^a-z0-9]/g, '');
  return owner === 'gateoneproserver' || owner === 'gateoneserver';
}

export function optionLabelsForMonths(months) {
  const duration = Number(months);
  const labels = [
    `${duration} ${duration === 1 ? 'Mês' : 'Meses'}`,
    `${duration} ${duration === 1 ? 'Mes' : 'Meses'}`,
    `${duration} ${duration === 1 ? 'mês' : 'meses'}`
  ];
  if (duration === 1) labels.push('30 dias');
  if (duration === 3) labels.push('90 dias');
  if (duration === 6) labels.push('180 dias');
  if (duration === 12) labels.push('365 dias', '1 Ano', '1 ano');
  return [...new Set(labels)];
}

function stripPrefix(value, prefix) {
  return String(value || '').replace(new RegExp(`^${prefix}\\s*`, 'i'), '').trim();
}

export function parseBitPanelExpiry(value) {
  const match = String(value || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function buildBitPanelUsername(customerName, stableSeed = '') {
  const normalized = String(customerName || 'cliente')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const base = normalized.slice(0, 16) || 'cliente';
  const suffix = String(stableSeed)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(-6);
  return `${base}${suffix}`.slice(0, 24);
}

export function bitPanelOperationFor(renewal) {
  return renewal.charge_stage === 'new_sale' || !renewal.bitpanel_list_id
    ? 'provision'
    : 'renew';
}

export function resolveBitPanelLoginUrl(baseUrl, configuredLoginUrl) {
  const base = new URL(baseUrl);
  const login = new URL(configuredLoginUrl || '/login', base);
  if (login.origin === base.origin && (login.pathname === '' || login.pathname === '/')) {
    login.pathname = '/login';
  }
  login.hash = '';
  return login.toString();
}

async function firstVisible(page, selector) {
  const candidates = page.locator(selector);
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function uniqueVisible(candidates) {
  let selected = null;
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (selected) throw readFailure('BITPANEL_READ_UNAVAILABLE');
    selected = candidate;
  }
  return selected;
}

async function findListSearchField(page) {
  // Current Vuetify inputs have empty placeholders; the label is the stable identity.
  const labelledFields = page.getByLabel('Buscar por nome', { exact: true });
  const labelled = await uniqueVisible(labelledFields);
  if (labelled) return labelled;
  const legacy = await uniqueVisible(page.locator(
    "input[placeholder='Buscar' i], input[placeholder='Pesquisar' i], input[placeholder='Buscar por nome' i], input[placeholder='Pesquisar por nome' i], input[type='search']"
  ));
  if (legacy) return legacy;
  try { await labelledFields.first().waitFor({ state: 'visible', timeout: 20_000 }); }
  catch { throw readFailure('BITPANEL_READ_UNAVAILABLE'); }
  const hydrated = await uniqueVisible(labelledFields);
  if (!hydrated) throw readFailure('BITPANEL_READ_UNAVAILABLE');
  return hydrated;
}

async function waitForBitPanelListData(page, baseUrl, { afterSearch = false } = {}) {
  const assertList = () => {
    const current = new URL(page.url());
    if (current.origin !== baseUrl) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
    if (current.pathname.includes('/login')) throw readFailure('BITPANEL_READ_REAUTH_REQUIRED');
    if (page.url() !== `${baseUrl}/list`) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  };
  if (afterSearch) await page.waitForTimeout(700);
  // The search asynchronously replaces the table; a visible empty tbody is not data readiness.
  try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); }
  catch { assertList(); throw readFailure('BITPANEL_READ_TIMEOUT'); }
  assertList();
  const headers = page.locator('table thead th');
  try { await headers.first().waitFor({ state: 'visible', timeout: 5_000 }); }
  catch { throw readFailure('BITPANEL_READ_UNAVAILABLE'); }
  const names = (await headers.allInnerTexts()).map(normalizeBitPanelText);
  for (const pattern of [/^(?:#?id|#|codigo)$/, /proprietario|revendedor|owner/, /usuario|login/]) {
    if (names.filter(name => pattern.test(name)).length !== 1) throw readFailure('BITPANEL_READ_UNAVAILABLE');
  }
  assertList();
}

async function listDetailValue(page, label) {
  const prefix = new RegExp(`^\\s*${label}\\s*`, 'i');
  const textMatches = page.getByText(prefix);
  await textMatches.first().waitFor({ state: 'visible' });
  // Current markup is <li><b>Label:</b> value</li>; reading the bold text loses the value.
  const rows = page.locator('li').filter({ hasText: prefix });
  const rowCount = await rows.count();
  if (rowCount > 1) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  const target = rowCount === 1 ? rows : textMatches;
  if (await target.count() !== 1) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  const text = (await target.innerText()).trim();
  const value = text.replace(prefix, '').trim();
  if (!prefix.test(text) || !value) throw readFailure('BITPANEL_READ_UNAVAILABLE');
  return value;
}

export async function openBitPanelSession(page, config, { storedSession = Boolean(config.BITPANEL_STORAGE_STATE) } = {}) {
  const loginUrl = resolveBitPanelLoginUrl(
    config.BITPANEL_BASE_URL,
    config.BITPANEL_LOGIN_URL
  );
  if (storedSession) {
    const baseUrl = readBaseUrl(config);
    if (new URL(loginUrl).origin !== baseUrl) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
    const listUrl = `${baseUrl}/list`;
    await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
    const loginRequired = async () => {
      if (new URL(page.url()).origin !== baseUrl) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
      if (new URL(page.url()).pathname.includes('/login')) return true;
      const username = await firstVisible(page, BITPANEL_LOGIN_SELECTORS.username);
      const password = await firstVisible(page, BITPANEL_LOGIN_SELECTORS.password);
      const submit = await firstVisible(page, BITPANEL_LOGIN_SELECTORS.submit);
      return Boolean(username && password && submit);
    };
    if (!await loginRequired()) {
      if (page.url() !== listUrl) throw readFailure('BITPANEL_READ_UNAVAILABLE');
      let tableReady = false;
      try { await page.locator('table tbody').waitFor({ state: 'visible' }); tableReady = true; }
      catch { /* A delayed authentication redirect is checked below. */ }
      if (!await loginRequired()) {
        if (!tableReady || page.url() !== listUrl) throw readFailure('BITPANEL_READ_UNAVAILABLE');
        return;
      }
    }
    // Only an actual login redirect/form allows falling back to configured credentials.
  }
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  const username = await firstVisible(page, BITPANEL_LOGIN_SELECTORS.username);
  const password = await firstVisible(page, BITPANEL_LOGIN_SELECTORS.password);
  const submit = await firstVisible(page, BITPANEL_LOGIN_SELECTORS.submit);
  const loginPage = new URL(page.url()).pathname.includes('/login');

  if (!username && !password && !loginPage) return;
  if (!username || !password || !submit) {
    throw new Error(
      'O BitPanel exige autenticação humana. Gere e importe uma nova sessão; o CAPTCHA não será contornado.'
    );
  }

  if (!config.BITPANEL_USERNAME || !config.BITPANEL_PASSWORD) {
    throw new Error('O BitPanel exige autenticação humana. Gere e importe uma nova sessão autenticada.');
  }

  await username.fill(config.BITPANEL_USERNAME);
  await password.fill(config.BITPANEL_PASSWORD);
  await submit.click();
  await page
    .waitForURL((url) => !url.pathname.includes('/login'), { timeout: 25_000 })
    .catch(() => null);

  const loginStillVisible =
    new URL(page.url()).pathname.includes('/login') ||
    (await username.isVisible().catch(() => false));
  if (loginStillVisible) {
    throw new Error(
      'O BitPanel recusou o acesso ou pediu CAPTCHA. Gere e importe uma nova sessão autenticada.'
    );
  }
}

async function captureListDetails(page, { expectedListId, expectedUsername, includePassword = true } = {}) {
  const match = page.url().match(/\/list\/view\/(\d+)/);
  if (!match) throw new Error('O BitPanel não abriu a página final da lista.');
  if (expectedListId !== undefined && match[1] !== expectedListId) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  const username = await listDetailValue(page, 'Usuário:');
  if (expectedUsername !== undefined && username !== expectedUsername) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  const password = includePassword ? await listDetailValue(page, 'Senha:') : undefined;
  const expiryText = await listDetailValue(page, 'Data de validade:');
  return {
    listId: match[1],
    username,
    ...(includePassword ? { password } : {}),
    expiryText,
    expiryDate: parseBitPanelExpiry(expiryText)
  };
}

async function findListByUsername(page, config, username) {
  const baseUrl = readBaseUrl(config);
  await page.goto(`${baseUrl}/list`, { waitUntil: 'domcontentloaded' });
  const search = await findListSearchField(page);
  await search.fill(username);
  await waitForBitPanelListData(page, baseUrl, { afterSearch: true });

  const columns = await tableColumnMap(page);
  const rows = page.locator('table tbody tr');
  const count = await rows.count();
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const cells = rows.nth(index).locator('td');
    if ((await cells.count()) <= Math.max(...Object.values(columns))) continue;
    const rowUsername = (await cells.nth(columns.username).innerText()).trim();
    if (rowUsername !== username) continue;
    matches.push({
      id: (await cells.nth(columns.id).innerText()).trim().replace(/^#/, ''),
      owner: (await cells.nth(columns.owner).innerText()).trim(),
      status: (await cells.nth(columns.status).innerText()).trim(),
      username: rowUsername,
      expiryText: (await cells.nth(columns.expiry).innerText()).trim()
    });
  }
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  if (matches.length > 1 || await next.count() > 1 ||
      (await next.count() === 1 && await next.isEnabled())) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  return matches[0] || null;
}

async function selectVuetifyOption(page, scope, buttonName, optionNames) {
  const button = scope.getByRole('button', { name: buttonName });
  if ((await button.count()) !== 1) {
    throw new Error(`Campo do BitPanel não encontrado: ${buttonName}`);
  }
  await button.click();
  const normalizeOption = value => normalizeBitPanelText(value).replace(/r\$\s*/g, 'r$');
  const expected = (Array.isArray(optionNames) ? optionNames : [optionNames])
    .map(normalizeOption);
  const options = page.locator(
    '[role="option"], .v-menu__content:visible .v-list-item, .v-overlay--active .v-list-item'
  );
  const count = await options.count();
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (!(await option.isVisible().catch(() => false))) continue;
    const label = normalizeOption(await option.innerText().catch(() => ''));
    if (expected.some((candidate) => label === candidate || (!candidate.includes('r$') && label.includes(candidate)))) {
      await option.click();
      return;
    }
  }
  throw new Error(`Opção do BitPanel não encontrada: ${expected.join(' / ')}`);
}

async function tableColumnMap(page) {
  const headers = await page.locator('table thead th').allInnerTexts().catch(() => []);
  const normalized = headers.map(normalizeBitPanelText);
  const find = (patterns, fallback) => {
    for (const pattern of patterns) {
      const index = normalized.findIndex((header) => pattern.test(header));
      if (index >= 0) return index;
    }
    return fallback;
  };
  return {
    id: find([/^#?id$/, /codigo/], 0),
    owner: find([/proprietario/, /revendedor/, /owner/], 2),
    // O BitPanel separa presenca (Status: Online/Offline) da situacao da
    // assinatura (Estado: Ativa/Expirada). Renovacao usa sempre o Estado.
    status: find([/^estado$/, /situacao/, /^status$/], 3),
    username: find([/usuario/, /login/, /^nome do usuario$/], 4),
    expiry: find([/validade/, /vencimento/, /expira/], 6)
  };
}

async function setConnections(scope, connections) {
  const target = Number(connections);
  const slider = scope.getByRole('slider');
  if ((await slider.count()) !== 1 || !Number.isInteger(target) || target < 1 || target > 10) {
    throw new Error('Quantidade de conexões inválida no cadastro do BitPanel.');
  }
  let current = Number((await slider.getAttribute('aria-valuenow')) || 0);
  while (current < target) {
    await slider.press('ArrowRight');
    current += 1;
  }
  while (current > target) {
    await slider.press('ArrowLeft');
    current -= 1;
  }
  const confirmed = Number((await slider.getAttribute('aria-valuenow')) || 0);
  if (confirmed !== target) throw new Error('O BitPanel não confirmou a quantidade de conexões.');
}

async function runWithBrowser(config, task) {
  if (
    !config.BITPANEL_STORAGE_STATE &&
    (!config.BITPANEL_USERNAME || !config.BITPANEL_PASSWORD)
  ) {
    throw new Error('Credenciais ou sessão autenticada do BitPanel não configuradas.');
  }
  await mkdir(config.ARTIFACTS_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: config.BITPANEL_HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  // The optional read deadline is never supplied by renewal/provisioning callers.
  const readDeadline = Number(config.BITPANEL_READ_TIMEOUT_MS);
  const readTimer = Number.isFinite(readDeadline) && readDeadline > 0
    ? setTimeout(() => browser.close().catch(() => null), readDeadline)
    : null;
  readTimer?.unref?.();
  try {
    let storageState;
    if (config.BITPANEL_STORAGE_STATE) {
      try {
        storageState = JSON.parse(config.BITPANEL_STORAGE_STATE);
        if (!storageState || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)) throw new Error();
      } catch {
        throw new Error('A sessão salva do BitPanel está corrompida. Importe uma nova sessão.');
      }
    }
    const context = await browser.newContext({
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      ...(storageState ? { storageState } : {})
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await openBitPanelSession(page, config, { storedSession: Boolean(storageState) });
    const result = await task(page);
    if (typeof config.saveBitPanelStorageState === 'function') {
      await config.saveBitPanelStorageState(await context.storageState());
    }
    return result;
  } finally {
    if (readTimer) clearTimeout(readTimer);
    await browser.close();
  }
}

const readFailure = code => Object.assign(new Error(code), { code });
const readCodes = new Set(['BITPANEL_READ_LINK_UNVERIFIED','BITPANEL_READ_REAUTH_REQUIRED','BITPANEL_READ_UNAVAILABLE','BITPANEL_READ_TIMEOUT']);

function readBaseUrl(config) {
  try {
    const url = new URL(config.BITPANEL_BASE_URL);
    if (url.protocol !== 'https:' || !['bitpanel.vip','www.bitpanel.vip'].includes(url.hostname) ||
        url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { throw readFailure('BITPANEL_READ_LINK_UNVERIFIED'); }
}

function readBinding(binding) {
  const listId = String(binding?.listId || '').trim();
  const username = String(binding?.username || '').trim();
  if (!/^\d{1,20}$/.test(listId) || !username || username.length > 120 ||
      /[\r\n\x00]/.test(username) || !isGateOneOwner(binding?.owner)) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  return { listId, username, owner: binding.owner };
}

// No buttons that modify the provider are reachable from this reader.
export async function readBitPanelAccessFromPage(page, config, binding) {
  const expected = readBinding(binding), baseUrl = readBaseUrl(config);
  await page.goto(`${baseUrl}/list`, { waitUntil: 'domcontentloaded' });
  if (new URL(page.url()).origin !== baseUrl) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  if (new URL(page.url()).pathname.includes('/login')) throw readFailure('BITPANEL_READ_REAUTH_REQUIRED');
  const search = await findListSearchField(page);
  await search.fill(expected.username);
  await waitForBitPanelListData(page, baseUrl, { afterSearch: true });
  const columns = await tableColumnMap(page), rows = page.locator('table tbody tr');
  const matches = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const cells = rows.nth(index).locator('td');
    if (await cells.count() <= Math.max(...Object.values(columns))) continue;
    const id = (await cells.nth(columns.id).innerText()).trim().replace(/^#/, '');
    const username = (await cells.nth(columns.username).innerText()).trim();
    const owner = (await cells.nth(columns.owner).innerText()).trim();
    if (id === expected.listId || username === expected.username) matches.push({ id, username, owner });
  }
  if (matches.length !== 1 || matches[0].id !== expected.listId || matches[0].username !== expected.username ||
      !isGateOneOwner(matches[0].owner) || normalizeBitPanelText(matches[0].owner) !== normalizeBitPanelText(expected.owner))
    throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  // Search must have a single page; incomplete or ambiguous results fail closed.
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  if (await next.count() > 1 || (await next.count() === 1 && await next.isEnabled())) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  const sourceUrl = `${baseUrl}/list/view/${expected.listId}`;
  await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' });
  if (page.url() !== sourceUrl) throw readFailure(new URL(page.url()).pathname.includes('/login') ? 'BITPANEL_READ_REAUTH_REQUIRED' : 'BITPANEL_READ_LINK_UNVERIFIED');
  // The detail username is checked inside captureListDetails before the password is read.
  const details = await captureListDetails(page, { expectedListId: expected.listId, expectedUsername: expected.username });
  if (details.listId !== expected.listId || details.username !== expected.username || !details.password ||
      details.password.length > 1000 || /[\r\n\x00]/.test(details.password)) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  return { listId: details.listId, username: details.username, password: details.password,
    owner: matches[0].owner, sourceUrl, verifiedAt: new Date().toISOString() };
}

export async function readBitPanelLinkedAccess(config, binding, { withSession = runWithBrowser } = {}) {
  readBinding(binding);
  const baseUrl = readBaseUrl(config);
  try {
    const login = new URL(resolveBitPanelLoginUrl(baseUrl, config.BITPANEL_LOGIN_URL));
    if (login.origin !== baseUrl) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
    return await withSession({ ...config, BITPANEL_BASE_URL: baseUrl, BITPANEL_READ_TIMEOUT_MS: 30_000 },
      page => readBitPanelAccessFromPage(page, config, binding));
  } catch (error) {
    if (readCodes.has(error?.code)) throw readFailure(error.code);
    if (/CAPTCHA|autentica|sessão|credenciais|acesso|login/i.test(String(error?.message))) throw readFailure('BITPANEL_READ_REAUTH_REQUIRED');
    throw readFailure('BITPANEL_READ_UNAVAILABLE');
  }
}

// The source path must be explicitly reviewed after authenticated UI inspection.
// This function does not discover pages or fetch URLs.
export function parseBitPanelDnsLinks(candidates, { sourceUrl, reviewedSourcePaths = [] } = {}) {
  let source;
  try {
    source = new URL(sourceUrl);
    if (readBaseUrl({ BITPANEL_BASE_URL: source.origin }) !== source.origin || source.search || source.hash ||
        source.username || source.password || !reviewedSourcePaths.includes(source.pathname)) return [];
  } catch { return []; }
  const results = new Map();
  for (const item of (Array.isArray(candidates) ? candidates : []).slice(0, 100)) {
    const label = String(item?.label || '').trim().slice(0, 100);
    if (!/^(dns|servidor)(?:\s+\d+)?$/i.test(label)) continue;
    try {
      const url = new URL(item.url), host = url.hostname.toLowerCase();
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
          url.pathname !== '/' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ||
          /(?:^|\.)(?:localhost|local|internal|invalid|example|test)$/.test(host) ||
          !['','80','443','8080','8000'].includes(url.port)) continue;
      results.set(url.href, { label, url: url.href, sourceUrl: source.href });
    } catch { /* Untrusted links are omitted. */ }
  }
  return [...results.values()].slice(0, 10);
}

function customerContentLink(value) {
  try {
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password ||
        [...url.searchParams.keys()].some(key => /token|pass|secret|user|auth|key/i.test(key))) return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|invalid|example|test)$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export function parseBitPanelCustomerNotices(entries, { sourceUrl = 'https://bitpanel.vip/notices', category = 'notices' } = {}) {
  let source;
  try { source = new URL(sourceUrl); } catch { throw readFailure('BITPANEL_READ_LINK_UNVERIFIED'); }
  if (!['notices','news'].includes(category) || readBaseUrl({BITPANEL_BASE_URL:source.origin}) !== source.origin || source.pathname !== `/${category}` ||
      source.search || source.hash || source.username || source.password) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  const notices = (Array.isArray(entries) ? entries : []).slice(0, 20).map(item => {
    const title = String(item.title || '').replace(/\s+/g,' ').trim().slice(0,200);
    const text = String(item.content || '').replace(/\r/g,'').trim()
      .replace(/https?:\/\/[^\s<>]+/gi, value => customerContentLink(value.replace(/[.,;!)]+$/,'')) ? value : '[link protegido]')
      .replace(/(?:password|senha|secret|token|api[_-]?key)\s*[:=]\s*[^\s]+/gi,'[dado protegido]');
    const publishedLabel = String(item.publishedLabel || '').replace(/\s+/g,' ').trim().slice(0,200);
    const publishedAt = parseBitPanelPublishedDate(publishedLabel);
    if (!title || !text || !publishedAt) return null;
    return {category,title,content:text.slice(0,1000),publishedLabel,
      publishedAt,sourceUrl:source.href,
      links:[...new Set((Array.isArray(item.links) ? item.links : []).map(customerContentLink).filter(Boolean))].slice(0,12),
      _fullText:text};
  }).filter(Boolean);
  if (!notices.length) throw readFailure('BITPANEL_READ_UNAVAILABLE');
  notices.sort((a,b) => new Date(b.publishedAt)-new Date(a.publishedAt));
  // Only the newest notice explicitly designating a NEW DNS may promote a domain.
  const announcement = category === 'notices' ? notices.find(item => /utilize\s+(?:a\s+)?nova\s+dns/i.test(item._fullText)) : null;
  const candidate = announcement?._fullText.match(/utilize\s+(?:a\s+)?nova\s+dns\s*:?\s*(https?:\/\/[^\s<>]+)/i)?.[1]?.replace(/[.,;!)]+$/,'');
  const dns = candidate ? parseBitPanelDnsLinks([{label:'DNS',url:candidate}],{
    sourceUrl:source.href,reviewedSourcePaths:['/notices']
  }).map(item => ({...item,publishedAt:announcement.publishedAt})) : [];
  return {notices:notices.slice(0,5).map(({_fullText,...item}) => item),dns,dnsVerified:Boolean(dns.length)};
}

export async function readBitPanelCustomerInformation(config, { withSession = runWithBrowser } = {}) {
  const baseUrl = readBaseUrl(config);
  try {
    const login = new URL(resolveBitPanelLoginUrl(baseUrl,config.BITPANEL_LOGIN_URL));
    if (login.origin !== baseUrl) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
    return await withSession({...config,BITPANEL_BASE_URL:baseUrl,BITPANEL_READ_TIMEOUT_MS:30_000},async page => {
      const verifiedAt = new Date().toISOString(), sections = [];
      for (const category of ['notices','news']) {
        const sourceUrl = `${baseUrl}/${category}`;
        await page.goto(sourceUrl,{waitUntil:'domcontentloaded'});
        if (page.url() !== sourceUrl) throw readFailure(new URL(page.url()).pathname.includes('/login') ? 'BITPANEL_READ_REAUTH_REQUIRED' : 'BITPANEL_READ_LINK_UNVERIFIED');
        const bodies = page.locator('.notices .notice-body');
        await bodies.first().waitFor({state:'visible'});
        const entries = await bodies.evaluateAll(nodes => nodes.slice(0,20).map(node => {
          const title = node.querySelector('h4')?.textContent || '';
          const publishedLabel = node.querySelector('h6')?.textContent || '';
          const content = (node.innerText || '').replace(title,'').replace(publishedLabel,'').trim();
          return {title,publishedLabel,content,links:[...node.querySelectorAll('a[href]')].map(link => link.href)};
        }));
        sections.push(parseBitPanelCustomerNotices(entries,{sourceUrl,category}));
      }
      await page.goto(`${baseUrl}/`,{waitUntil:'domcontentloaded'});
      if (page.url() !== `${baseUrl}/`) throw readFailure(new URL(page.url()).pathname.includes('/login') ? 'BITPANEL_READ_REAUTH_REQUIRED' : 'BITPANEL_READ_LINK_UNVERIFIED');
      const links = page.locator('a[href*="t.me/"]');
      let telegram = null;
      if (await links.count() === 1) {
        const candidate = customerContentLink(await links.first().getAttribute('href'));
        if (candidate && new URL(candidate).protocol === 'https:' && new URL(candidate).hostname === 't.me')
          telegram={channelUrl:candidate,verifiedAt,sourceUrl:`${baseUrl}/`};
      }
      return {source:`${baseUrl}/notices`,verifiedAt,status:'READY',
        posts:sections.flatMap(section=>section.notices.map(({sourceUrl,publishedLabel,...post})=>({...post,source:'bitpanel',url:sourceUrl,verifiedAt}))),
        dns:sections[0].dns.map(item=>({name:'DNS atual',value:item.url.replace(/\/$/,''),status:'READY',verifiedAt,sourceUrl:item.sourceUrl})),
        dnsVerified:sections[0].dnsVerified,telegram,downloadsUrl:'https://bitplatform.vip/'};
    });
  } catch (error) {
    if (readCodes.has(error?.code)) throw readFailure(error.code);
    if (/CAPTCHA|autentica|sessão|credenciais|acesso|login/i.test(String(error?.message))) throw readFailure('BITPANEL_READ_REAUTH_REQUIRED');
    throw readFailure('BITPANEL_READ_UNAVAILABLE');
  }
}

function statusFromBitPanel(value, expiryDate) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('expir')) return 'late';
  if (normalized.includes('susp')) return 'suspended';
  if (normalized.includes('cancel')) return 'cancelled';
  if (expiryDate && expiryDate < new Date().toISOString().slice(0, 10)) return 'late';
  return 'active';
}

export async function testBitPanelConnection(config, { withSession = runWithBrowser } = {}) {
  return withSession(config, async (page) => {
    const baseUrl = readBaseUrl(config);
    await page.goto(`${baseUrl}/list`, { waitUntil: 'domcontentloaded' });
    await waitForBitPanelListData(page, baseUrl);
    return { ok: true, message: 'Login confirmado e lista de clientes encontrada.' };
  });
}

async function runWithReadOnlyBrowser(config, task) {
  if (!config.BITPANEL_STORAGE_STATE) throw readFailure('BITPANEL_READ_REAUTH_REQUIRED');
  // An expired session may show the login page, but this reader can never submit
  // configured credentials or bypass the human authentication requirement.
  return runWithBrowser({ ...config, BITPANEL_USERNAME: '', BITPANEL_PASSWORD: '' }, task);
}

const lookupCredential = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(value);

function lookupDate(value) {
  const matches = [...String(value || '').matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)];
  if (matches.length !== 1) return null;
  const [, day, month, year] = matches[0], iso = `${year}-${month}-${day}`;
  if (Number(year) < 1900) return null;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

async function lookupColumnMap(page) {
  const names = (await page.locator('table thead th').allInnerTexts()).map(normalizeBitPanelText);
  const columns = {}, patterns = { id: /^(?:#?id|#|codigo)$/, username: /^(?:usuario|login|nome do usuario)$/,
    owner: /proprietario|revendedor|owner/, state: /^(?:estado|situacao)$/, expiry: /validade|vencimento|expira/ };
  for (const [field, pattern] of Object.entries(patterns)) {
    let matches = names.map((name, index) => pattern.test(name) ? index : -1).filter(index => index >= 0);
    // Legacy tables use Status for the subscription state; current tables also
    // have a presence Status column, so an explicit Estado/Situação wins.
    if (field === 'state' && matches.length === 0)
      matches = names.map((name, index) => name === 'status' ? index : -1).filter(index => index >= 0);
    if (matches.length !== 1) throw readFailure('BITPANEL_READ_UNAVAILABLE');
    columns[field] = matches[0];
  }
  if (new Set(Object.values(columns)).size !== 5) throw readFailure('BITPANEL_READ_UNAVAILABLE');
  return { columns, headerSignature: JSON.stringify(names) };
}

function assertLookupPage(page, expectedUrl, baseUrl) {
  let current;try { current = new URL(page.url()); } catch { throw readFailure('BITPANEL_READ_LINK_UNVERIFIED'); }
  if (current.origin !== baseUrl) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  if (current.pathname.includes('/login') || current.pathname.includes('/captcha')) throw readFailure('BITPANEL_READ_REAUTH_REQUIRED');
  if (page.url() !== expectedUrl) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
}

const lookupCaptcha = "iframe[src*='recaptcha' i], iframe[src*='hcaptcha' i], iframe[src*='challenges.cloudflare' i], [data-sitekey], .g-recaptcha, .h-captcha";
async function assertLookupProtectedPage(page, expectedUrl, baseUrl) {
  assertLookupPage(page, expectedUrl, baseUrl);
  for (const selector of [BITPANEL_LOGIN_SELECTORS.username, BITPANEL_LOGIN_SELECTORS.password, lookupCaptcha])
    if (await firstVisible(page, selector)) throw readFailure('BITPANEL_READ_REAUTH_REQUIRED');
  assertLookupPage(page, expectedUrl, baseUrl);
}

/** Private observations only: JSON serialization exposes status/counts, never account data. */
export async function readBitPanelExactMissingAccesses(config, usernames,
  { withSession = runWithReadOnlyBrowser, maxPages = 100, now = () => new Date(), onSaveStorageState } = {}) {
  if (!Array.isArray(usernames) || usernames.length < 1 || usernames.length > 13 ||
      usernames.some(value => !lookupCredential(value, 120)) ||
      new Set(usernames.map(value => value.toLowerCase())).size !== usernames.length ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
      onSaveStorageState !== undefined && typeof onSaveStorageState !== 'function')
    throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  const baseUrl = readBaseUrl(config), listUrl = `${baseUrl}/list`;
  try {
    if (new URL(resolveBitPanelLoginUrl(baseUrl, config.BITPANEL_LOGIN_URL)).origin !== baseUrl)
      throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
    const deadline = Math.min(120_000, Math.max(1000, Number(config.BITPANEL_READ_TIMEOUT_MS) || 120_000));
    return await withSession({ ...config, BITPANEL_BASE_URL: baseUrl, BITPANEL_USERNAME: '', BITPANEL_PASSWORD: '',
      BITPANEL_READ_TIMEOUT_MS: deadline, ...(onSaveStorageState ? { saveBitPanelStorageState: onSaveStorageState } : {}) }, async page => {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
      await assertLookupProtectedPage(page, listUrl, baseUrl);
      await waitForBitPanelListData(page, baseUrl);
      const firstHeaders = await lookupColumnMap(page), { columns } = firstHeaders;
      const wanted = new Set(usernames), candidates = [], ids = new Set(), logins = new Set(),
        duplicateIds = new Set(), duplicateLogins = new Set(), pageSignatures = new Set();
      let scannedPages = 0, scannedRows = 0, complete = false;
      for (; scannedPages < maxPages;) {
        await assertLookupProtectedPage(page, listUrl, baseUrl);
        if ((await lookupColumnMap(page)).headerSignature !== firstHeaders.headerSignature)
          throw readFailure('BITPANEL_READ_UNAVAILABLE');
        const rows = page.locator('table tbody tr'), count = await rows.count(), signatureRows = [];
        if (count < 1 || count > 500) throw readFailure('BITPANEL_READ_UNAVAILABLE');
        for (let index = 0; index < count; index++) {
          const cells = rows.nth(index).locator('td');
          if (await cells.count() <= Math.max(...Object.values(columns))) throw readFailure('BITPANEL_READ_UNAVAILABLE');
          const id = (await cells.nth(columns.id).innerText()).trim().replace(/^#/, ''),
            username = (await cells.nth(columns.username).innerText()).trim();
          if (!/^[1-9]\d{0,19}$/.test(id) || !lookupCredential(username, 120)) throw readFailure('BITPANEL_READ_UNAVAILABLE');
          signatureRows.push([id, username]);scannedRows++;
          if (ids.has(id)) duplicateIds.add(id);ids.add(id);
          const loginKey = username.toLowerCase();
          if (logins.has(loginKey)) duplicateLogins.add(loginKey);logins.add(loginKey);
          if (wanted.has(username)) candidates.push({ id, username,
            owner: (await cells.nth(columns.owner).innerText()).trim(),
            state: (await cells.nth(columns.state).innerText()).trim(),
            expiry: (await cells.nth(columns.expiry).innerText()).trim(), observedAt: now() });
        }
        const signature = JSON.stringify(signatureRows);
        if (pageSignatures.has(signature)) throw readFailure('BITPANEL_READ_UNAVAILABLE');
        pageSignatures.add(signature);scannedPages++;
        const next = page.getByRole('button', { name: 'Next page', exact: true });
        if (await next.count() !== 1) throw readFailure('BITPANEL_READ_UNAVAILABLE');
        if (!await next.isEnabled()) { complete = true;break; }
        if (scannedPages >= maxPages) throw readFailure('BITPANEL_READ_UNAVAILABLE');
        await next.click();
        await assertLookupProtectedPage(page, listUrl, baseUrl);
        await waitForBitPanelListData(page, baseUrl);
        await assertLookupProtectedPage(page, listUrl, baseUrl);
        try {
          await page.waitForFunction(({ previous, idColumn, usernameColumn }) => {
            const rows = [...document.querySelectorAll('table tbody tr')].map(row => [...row.querySelectorAll('td')])
              .filter(cells => cells.length > Math.max(idColumn, usernameColumn));
            const current = JSON.stringify(rows.map(cells => [cells[idColumn].textContent.trim().replace(/^#/, ''), cells[usernameColumn].textContent.trim()]));
            return rows.length > 0 && current !== previous;
          }, { previous: signature, idColumn: columns.id, usernameColumn: columns.username }, { timeout: 20_000 });
        } catch {
          assertLookupPage(page, listUrl, baseUrl);throw readFailure('BITPANEL_READ_TIMEOUT');
        }
        await waitForBitPanelListData(page, baseUrl);
      }
      if (!complete) throw readFailure('BITPANEL_READ_UNAVAILABLE');
      const observations = [], counts = { requested: usernames.length, scannedPages, scannedRows, verified: 0, notFound: 0,
        rejected: 0, rejectionReasons: {} };
      const reject = (requestIndex, reason) => {
        counts.rejected++;counts.rejectionReasons[reason] = (counts.rejectionReasons[reason] || 0) + 1;
        observations.push({ requestIndex, status: 'REJECTED', reason });
      };
      for (const [requestIndex, username] of usernames.entries()) {
        const matches = candidates.filter(row => row.username === username), candidate = matches[0];
        if (duplicateLogins.has(username.toLowerCase())) { reject(requestIndex, 'DUPLICATE_LOGIN');continue; }
        if (!candidate) { counts.notFound++;observations.push({ requestIndex, status: 'NOT_FOUND' });continue; }
        if (matches.length !== 1 || duplicateIds.has(candidate.id)) { reject(requestIndex, 'DUPLICATE_LIST_ID');continue; }
        if (!lookupCredential(candidate.owner, 120) || !isGateOneOwner(candidate.owner)) { reject(requestIndex, 'FOREIGN_OWNER');continue; }
        const expiresOn = lookupDate(candidate.expiry), state = normalizeBitPanelText(candidate.state);
        if (!expiresOn) { reject(requestIndex, 'INVALID_EXPIRY');continue; }
        if (!['ativa', 'ativo', 'active', 'expirada', 'expirado', 'expired'].includes(state)) { reject(requestIndex, 'PROVIDER_STATE_UNVERIFIED');continue; }
        const observedAt = new Date(candidate.observedAt), beforeDetail = now();
        if (!Number.isFinite(observedAt.getTime()) || observedAt > beforeDetail || beforeDetail - observedAt > 60_000) {
          reject(requestIndex, 'STALE_OBSERVATION');continue;
        }
        const sourceUrl = `${baseUrl}/list/view/${candidate.id}`;
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' });await assertLookupProtectedPage(page, sourceUrl, baseUrl);
        try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); }
        catch { await assertLookupProtectedPage(page, sourceUrl, baseUrl);throw readFailure('BITPANEL_READ_TIMEOUT'); }
        await assertLookupProtectedPage(page, sourceUrl, baseUrl);
        const details = await captureListDetails(page, { expectedListId: candidate.id, expectedUsername: username, includePassword: false });
        if (lookupDate(details.expiryText) !== expiresOn) { reject(requestIndex, 'DETAIL_EXPIRY_CHANGED');continue; }
        await assertLookupProtectedPage(page, sourceUrl, baseUrl);
        const password = await listDetailValue(page, 'Senha:');
        if (!lookupCredential(password, 1000)) { reject(requestIndex, 'PASSWORD_UNVERIFIED');continue; }
        const confirmed = await captureListDetails(page, { expectedListId: candidate.id, expectedUsername: username, includePassword: false });
        await assertLookupProtectedPage(page, sourceUrl, baseUrl);
        if (lookupDate(confirmed.expiryText) !== expiresOn) { reject(requestIndex, 'DETAIL_EXPIRY_CHANGED');continue; }
        const verifiedAt = now(), today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(verifiedAt);
        if (!Number.isFinite(verifiedAt.getTime()) || verifiedAt < beforeDetail || verifiedAt - observedAt > 60_000) {
          reject(requestIndex, 'STALE_OBSERVATION');continue;
        }
        observations.push({ requestIndex, status: 'VERIFIED', listId: candidate.id, username, owner: candidate.owner, password,
          expiresOn, subscriptionStatus: ['expirada', 'expirado', 'expired'].includes(state) || expiresOn < today ? 'late' : 'active',
          sourceUrl, verifiedAt: verifiedAt.toISOString() });counts.verified++;
      }
      const result = { status: 'READY', counts };
      Object.defineProperty(result, 'observations', { value: observations, enumerable: false });
      return result;
    });
  } catch (error) {
    if (readCodes.has(error?.code)) throw readFailure(error.code);
    if (/CAPTCHA|autentica|sessão|credenciais|acesso|login/i.test(String(error?.message))) throw readFailure('BITPANEL_READ_REAUTH_REQUIRED');
    throw readFailure('BITPANEL_READ_UNAVAILABLE');
  }
}

export async function fetchBitPanelCustomers(config) {
  return runWithBrowser(config, async (page) => {
    await page.goto(`${config.BITPANEL_BASE_URL}/list`, { waitUntil: 'domcontentloaded' });
    await page.locator('table tbody').waitFor({ state: 'visible' });
    const customers = new Map();
    const columns = await tableColumnMap(page);
    const highestColumn = Math.max(...Object.values(columns));

    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const rows = page.locator('table tbody tr');
      const count = await rows.count();
      let firstIdOnPage = '';
      for (let index = 0; index < count; index += 1) {
        const cells = rows.nth(index).locator('td');
        if ((await cells.count()) <= highestColumn) continue;
        const id = (await cells.nth(columns.id).innerText()).trim().replace(/^#/, '');
        if (!firstIdOnPage) firstIdOnPage = id;
        const owner = (await cells.nth(columns.owner).innerText()).trim();
        const rawStatus = (await cells.nth(columns.status).innerText()).trim();
        const username = (await cells.nth(columns.username).innerText()).trim();
        const expiresText = (await cells.nth(columns.expiry).innerText()).trim();
        const expiresOn = parseBitPanelExpiry(expiresText);
        if (!id || !username || !expiresOn) continue;
        customers.set(id, {
          bitpanelListId: id,
          bitpanelReference: username,
          owner,
          expiresOn,
          status: statusFromBitPanel(rawStatus, expiresOn)
        });
      }

      const next = page.getByRole('button', { name: 'Next page', exact: true });
      if ((await next.count()) !== 1 || !(await next.isEnabled())) break;
      await next.click();
      const firstCell = page.locator('table tbody tr td').first();
      await firstCell.waitFor({ state: 'visible' });
      await page.waitForFunction(
        (previousId) =>
          document.querySelector('table tbody tr td')?.textContent?.trim().replace(/^#/, '') !== previousId,
        firstIdOnPage,
        { timeout: 10_000 }
      );
    }
    return [...customers.values()];
  });
}

async function captureBoundRenewalDetails(page, detailsUrl, binding, includePassword) {
  if (page.url() !== detailsUrl) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  return captureListDetails(page, { expectedListId: binding.listId,
    expectedUsername: binding.username, includePassword });
}

const CREDIT_BALANCE_TEXT = /^\s*(?:Saldo (?:em|de) cr[eé]ditos|Cr[eé]ditos dispon[ií]veis)\s*:\s*(?:0|[1-9]\d*)\s*$/i;

// An icon and an unlabelled number do not establish what the number means.
// Only an explicit, complete available-credit label can authorize expenditure.
export function parseBitPanelCreditBalance(text) {
  if (typeof text !== 'string' || text.length > 120 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(text)) return null;
  const clean = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u00a0/g, ' ').trim();
  const match = /^(?:saldo (?:em|de) creditos|creditos disponiveis)\s*:\s*(0|[1-9]\d*)$/i.exec(clean);
  const available = match ? Number(match[1]) : null;
  return Number.isSafeInteger(available) ? available : null;
}

export async function readBitPanelCreditBalance(page, baseUrl) {
  const assertSource = () => {
    let current;
    try { current = new URL(page.url()); } catch { throw readFailure('BITPANEL_READ_LINK_UNVERIFIED'); }
    if (current.origin !== baseUrl || current.pathname !== '/list' || current.search || current.hash)
      throw readFailure(current.pathname.includes('/login') && current.origin === baseUrl ?
        'BITPANEL_READ_REAUTH_REQUIRED' : 'BITPANEL_READ_LINK_UNVERIFIED');
  };
  assertSource();
  let available = null, visible = 0;
  try {
    const candidates = page.getByText(CREDIT_BALANCE_TEXT);
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible()) continue;
      visible += 1;
      available = parseBitPanelCreditBalance(await candidate.innerText());
    }
  } catch { available = null; visible = 0; }
  assertSource();
  return visible === 1 ? available : null;
}

function creditQuote(text, config, renewal) {
  let validated;
  try { validated = validateBitPanelRenewalQuote(text, renewal, config.BITPANEL_AUTOMATIC_RENEWAL_POLICY); }
  catch { throw readFailure('RENEWAL_PROVIDER_QUOTE_MISMATCH'); }
  if (validated) return validated;
  // A human-approved operation also needs an intact provider quote for its
  // available-credit check, even when the automatic policy does not apply.
  const quote = parseBitPanelRenewalQuote(text);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const selectedPlan = String(config.BITPANEL_PLAN_LABEL || '').split(',')[0].trim();
  if (quote.listId !== String(renewal.bitpanel_list_id || '') || quote.months !== renewal.duration_months ||
      !selectedPlan || quote.planLabel !== selectedPlan || !positive(quote.credits) ||
      !positive(quote.connections) || !positive(quote.unitPriceCents) || !positive(quote.totalPriceCents) ||
      !positive(quote.unitPriceCents * quote.months * quote.connections) ||
      quote.totalPriceCents !== quote.unitPriceCents * quote.months * quote.connections)
    throw readFailure('RENEWAL_PROVIDER_QUOTE_MISMATCH');
  return quote;
}

function creditCapacity(availableCredits, quote) {
  return { status: availableCredits === null ? 'unverified' : 'verified', availableCredits,
    sufficient: availableCredits === null ? null : availableCredits >= quote.credits };
}

function requireCreditCapacity(availableCredits, quote) {
  if (!Number.isSafeInteger(availableCredits) || availableCredits < 0)
    throw readFailure('RENEWAL_PROVIDER_BALANCE_UNVERIFIED');
  if (availableCredits < quote.credits) throw readFailure('RENEWAL_PROVIDER_INSUFFICIENT_CREDITS');
}

// Preparation only opens and reads the form. The final actuator is deliberately
// outside this function so the administrator preview follows the same path.
async function prepareBitPanelRenewalFromPage(page, config, renewal, { allowAlreadyRenewed = false } = {}) {
  const binding = readBinding({ listId: renewal.bitpanel_list_id,
    username: renewal.bitpanel_reference, owner: renewal.bitpanel_owner });
  const baseUrl = readBaseUrl(config), listId = binding.listId;
  const detailsUrl = `${baseUrl}/list/view/${listId}`;
  if (renewal.charge_stage === 'new_sale') throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  await page.goto(detailsUrl, { waitUntil: 'domcontentloaded' });
  const before = await captureBoundRenewalDetails(page, detailsUrl, binding, false);
  const row = await findListByUsername(page, { ...config, BITPANEL_BASE_URL: baseUrl }, binding.username);
  if (!row || row.id !== listId || row.username !== binding.username || !isGateOneOwner(row.owner) ||
      normalizeBitPanelText(row.owner) !== normalizeBitPanelText(binding.owner)) throw readFailure('BITPANEL_READ_LINK_UNVERIFIED');
  if (!renewal.expected_expiration) throw new Error('RENEWAL_EXPECTED_EXPIRATION_REQUIRED');
  if (allowAlreadyRenewed && before.expiryDate === renewal.expected_expiration)
    return { alreadyRenewed: true, before, binding, listId, detailsUrl };
  if (before.expiryDate !== renewal.current_expiry) throw new Error('RENEWAL_PROVIDER_EXPIRATION_MISMATCH');
  const menuIcon = page.locator(`i[title="Mais opções, lista ${listId}"]`);
  if (await menuIcon.count() !== 1) throw new Error('RENEWAL_PREVIEW_UNAVAILABLE');
  await menuIcon.click();
  await page.getByRole('menuitem', { name: 'Renovar', exact: true }).click();
  const dialog = page.locator('.v-dialog--active');
  await dialog.waitFor({ state: 'visible' });
  await selectVuetifyOption(page, dialog, /^Selecione o plano/, config.BITPANEL_PLAN_LABEL);
  await selectVuetifyOption(page, dialog, /^Selecione a validade/, optionLabelsForMonths(renewal.duration_months));
  const quote = creditQuote(await dialog.innerText(), config, renewal);
  const availableCredits = await readBitPanelCreditBalance(page, baseUrl);
  return { before, binding, listId, detailsUrl, dialog, quote, availableCredits };
}

async function closeRenewalPreview(page) {
  const dialog = page.locator('.v-dialog--active');
  const count = await dialog.count();
  if (count === 0) return;
  if (count !== 1) throw readFailure('RENEWAL_PREVIEW_CLOSE_FAILED');
  if (!await dialog.isVisible()) return;
  const exit = dialog.getByRole('button', { name: /^Sair$/i, exact: true });
  if (await exit.count() !== 1) throw readFailure('RENEWAL_PREVIEW_CLOSE_FAILED');
  try {
    await exit.click();
    await dialog.waitFor({ state: 'hidden' });
  } catch { throw readFailure('RENEWAL_PREVIEW_CLOSE_FAILED'); }
}

const previewCodes = new Set([...readCodes, 'RENEWAL_PROVIDER_QUOTE_MISMATCH',
  'RENEWAL_PROVIDER_EXPIRATION_MISMATCH', 'RENEWAL_EXPECTED_EXPIRATION_REQUIRED',
  'RENEWAL_PREVIEW_UNAVAILABLE', 'RENEWAL_PREVIEW_CLOSE_FAILED']);

// Available while automation is disabled. It never claims a job, reads a
// password, captures a screenshot, or obtains the final RENOVAR button.
export async function previewBitPanelRenewal(config, renewal, { withSession = runWithBrowser } = {}) {
  try {
    const previewRenewal = { ...renewal, automatic_renewal: true };
    if (config.BITPANEL_AUTOMATIC_RENEWAL_POLICY?.enabled !== true) throw new Error('RENEWAL_PROVIDER_QUOTE_MISMATCH');
    return await withSession({ ...config, BITPANEL_READ_TIMEOUT_MS: 30_000 }, async page => {
      try {
        const prepared = await prepareBitPanelRenewalFromPage(page, config, previewRenewal);
        return { prepared: true, submitted: false, quote: prepared.quote,
          balance: creditCapacity(prepared.availableCredits, prepared.quote),
          sourceUrl: prepared.detailsUrl, verifiedAt: new Date().toISOString() };
      } finally { await closeRenewalPreview(page); }
    });
  } catch (error) {
    const code = error?.code || error?.message;
    if (previewCodes.has(code)) throw readFailure(code);
    if (/CAPTCHA|autentica|sessão|credenciais|acesso|login/i.test(String(error?.message))) throw readFailure('BITPANEL_READ_REAUTH_REQUIRED');
    throw readFailure('RENEWAL_PREVIEW_UNAVAILABLE');
  }
}

export async function renewInBitPanel(config, renewal, { withSession = runWithBrowser } = {}) {
  if (config.BITPANEL_MODE === 'disabled') throw new Error('Automação BitPanel desativada.');
  if (config.BITPANEL_MODE === 'simulation') {
    return {
      operation: 'renew',
      simulated: true,
      beforeExpiry: renewal.current_expiry,
      afterExpiry: renewal.current_expiry,
      evidencePath: null
    };
  }
  if (!renewal.bitpanel_list_id) throw new Error('ID da lista BitPanel não informado.');

  return withSession(config, async (page) => {
    const { before, binding, listId, detailsUrl, dialog, quote, availableCredits, alreadyRenewed } =
      await prepareBitPanelRenewalFromPage(page, config, renewal, { allowAlreadyRenewed: true });
    if (alreadyRenewed) {
      return {operation:'renew',simulated:false,alreadyRenewed:true,beforeExpiry:renewal.current_expiry,
        afterExpiry:before.expiryDate,evidencePath:null,listId,username:before.username};
    }

    const evidencePath = join(config.ARTIFACTS_DIR, `${Date.now()}-${safeName(renewal.id)}-renovacao.png`);
    let submitted = false;
    try {
      requireCreditCapacity(availableCredits, quote);
      if (renewal.automatic_renewal === true && typeof config.BITPANEL_BEFORE_RENEWAL_SUBMIT !== 'function')
        throw readFailure('RENEWAL_BINDING_UNVERIFIED');
      await page.screenshot({ path: evidencePath, fullPage: true });
      const renewButton = dialog.getByRole('button', { name: 'Renovar', exact: true });
      if ((await renewButton.count()) !== 1) throw new Error('Botão final de renovação não encontrado.');
      const currentQuote = creditQuote(await dialog.innerText(), config, renewal);
      requireCreditCapacity(await readBitPanelCreditBalance(page, readBaseUrl(config)), currentQuote);
      if (typeof config.BITPANEL_BEFORE_RENEWAL_SUBMIT === 'function') {
        let result;
        try { result = await config.BITPANEL_BEFORE_RENEWAL_SUBMIT(); }
        catch { throw readFailure('RENEWAL_BINDING_UNVERIFIED'); }
        if (result?.verified !== true) throw readFailure('RENEWAL_BINDING_UNVERIFIED');
      }
      await renewButton.click();
      submitted = true;
      await dialog.waitFor({ state: 'hidden' });
    } finally {
      if (!submitted) await closeRenewalPreview(page);
    }

    await page.goto(detailsUrl, { waitUntil: 'domcontentloaded' });
    const after = await captureBoundRenewalDetails(page, detailsUrl, binding, true);
    if (after.expiryDate !== renewal.expected_expiration) throw new Error('RENEWAL_PROVIDER_EXPIRATION_MISMATCH');
    return {
      operation: 'renew',
      simulated: false,
      beforeExpiry: before.expiryDate,
      afterExpiry: after.expiryDate,
      evidencePath,
      listId,
      username: after.username,
      password: after.password
    };
  });
}

export async function provisionInBitPanel(config, renewal) {
  if (config.BITPANEL_MODE === 'disabled') throw new Error('Automação BitPanel desativada.');
  const username =
    renewal.bitpanel_reference ||
    buildBitPanelUsername(renewal.customer_name, renewal.customer_id);
  if (config.BITPANEL_MODE === 'simulation') {
    return {
      operation: 'provision',
      simulated: true,
      beforeExpiry: null,
      afterExpiry: null,
      evidencePath: null,
      listId: null,
      username,
      password: null
    };
  }

  return runWithBrowser(config, async (page) => {
    const existing = await findListByUsername(page, config, username);
    if (existing) {
      await page.goto(`${config.BITPANEL_BASE_URL}/list/view/${existing.id}`, {
        waitUntil: 'domcontentloaded'
      });
      const details = await captureListDetails(page);
      return {
        operation: 'provision',
        simulated: false,
        existing: true,
        beforeExpiry: null,
        afterExpiry: details.expiryDate,
        evidencePath: null,
        ...details
      };
    }

    const createButton = page.locator('main button.v-btn--fixed.v-btn--fab');
    if ((await createButton.count()) !== 1) {
      throw new Error('Botão de nova lista do BitPanel não encontrado.');
    }
    await createButton.click();
    await page.getByText('Adicionar nova lista.', { exact: true }).waitFor({ state: 'visible' });

    const main = page.locator('main');
    const usernameInput = main.getByRole('textbox', { name: 'Nome do usuário' });
    if ((await usernameInput.count()) !== 1) {
      throw new Error('Campo de usuário do BitPanel não encontrado.');
    }
    await usernameInput.fill(username);
    await selectVuetifyOption(
      page,
      main,
      /^Selecione o plano de tv/,
      config.BITPANEL_TV_PACKAGE
    );
    await selectVuetifyOption(
      page,
      main,
      /^Selecione o plano$/,
      config.BITPANEL_PLAN_LABEL
    );
    await setConnections(main, config.BITPANEL_DEFAULT_CONNECTIONS);
    await selectVuetifyOption(
      page,
      main,
      /^Selecione a validade/,
      optionLabelsForMonths(renewal.duration_months)
    );

    const note = main.getByRole('textbox', { name: 'Nota' });
    if ((await note.count()) === 1) {
      await note.fill(`Gate One Pro - ${renewal.customer_name}`.slice(0, 120));
    }
    const evidencePath = join(
      config.ARTIFACTS_DIR,
      `${Date.now()}-${safeName(renewal.id)}-cadastro.png`
    );
    await page.screenshot({ path: evidencePath, fullPage: true });

    const create = main.getByRole('button', { name: 'Criar', exact: true });
    if ((await create.count()) !== 1) throw new Error('Botão final de cadastro não encontrado.');
    await Promise.all([
      page.waitForURL(/\/list\/view\/\d+/, { timeout: 30_000 }),
      create.click()
    ]);
    const details = await captureListDetails(page);
    return {
      operation: 'provision',
      simulated: false,
      existing: false,
      beforeExpiry: null,
      afterExpiry: details.expiryDate,
      evidencePath,
      ...details
    };
  });
}
