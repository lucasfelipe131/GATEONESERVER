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

function optionLabelForMonths(months) {
  return Number(months) === 1 ? '1 Mês' : `${Number(months)} Meses`;
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

async function openSession(page, config) {
  const loginUrl = resolveBitPanelLoginUrl(
    config.BITPANEL_BASE_URL,
    config.BITPANEL_LOGIN_URL
  );
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  const username = await firstVisible(page, BITPANEL_LOGIN_SELECTORS.username);
  const password = await firstVisible(page, BITPANEL_LOGIN_SELECTORS.password);
  const submit = await firstVisible(page, BITPANEL_LOGIN_SELECTORS.submit);
  const loginPage = new URL(page.url()).pathname.includes('/login');

  if (!username && !password && !loginPage) return;
  if (!username || !password || !submit) {
    throw new Error('Tela de login do BitPanel mudou. Revisão manual necessária.');
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
    throw new Error('O BitPanel recusou o acesso. Confira o usuário e a senha em Configurações.');
  }
}

async function captureListDetails(page) {
  const usernameText = await page.getByText(/^Usuário:/).innerText();
  const passwordText = await page.getByText(/^Senha:/).innerText();
  const expiryText = await page.getByText(/^Data de validade:/).innerText();
  const match = page.url().match(/\/list\/view\/(\d+)/);
  if (!match) throw new Error('O BitPanel não abriu a página final da lista.');
  return {
    listId: match[1],
    username: stripPrefix(usernameText, 'Usuário:'),
    password: stripPrefix(passwordText, 'Senha:'),
    expiryText: stripPrefix(expiryText, 'Data de validade:'),
    expiryDate: parseBitPanelExpiry(expiryText)
  };
}

async function findListByUsername(page, config, username) {
  await page.goto(`${config.BITPANEL_BASE_URL}/list`, { waitUntil: 'domcontentloaded' });
  const search = page.getByRole('textbox', { name: 'Buscar por nome' });
  if ((await search.count()) !== 1) {
    throw new Error('Busca de listas do BitPanel não encontrada.');
  }
  await search.fill(username);
  await page.waitForTimeout(700);

  const rows = page.locator('table tbody tr');
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const cells = rows.nth(index).locator('td');
    if ((await cells.count()) < 7) continue;
    const rowUsername = (await cells.nth(4).innerText()).trim();
    if (rowUsername !== username) continue;
    return {
      id: (await cells.nth(0).innerText()).trim().replace(/^#/, ''),
      username: rowUsername,
      expiryText: (await cells.nth(6).innerText()).trim()
    };
  }
  return null;
}

async function selectVuetifyOption(page, scope, buttonName, optionName) {
  const button = scope.getByRole('button', { name: buttonName });
  if ((await button.count()) !== 1) {
    throw new Error(`Campo do BitPanel não encontrado: ${buttonName}`);
  }
  await button.click();
  const option = page.getByRole('option', { name: optionName, exact: true });
  if ((await option.count()) !== 1) {
    throw new Error(`Opção do BitPanel não encontrada: ${optionName}`);
  }
  await option.click();
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
  if (!config.BITPANEL_USERNAME || !config.BITPANEL_PASSWORD) {
    throw new Error('Credenciais do BitPanel não configuradas na Railway.');
  }
  await mkdir(config.ARTIFACTS_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: config.BITPANEL_HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const context = await browser.newContext({
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await openSession(page, config);
    return await task(page);
  } finally {
    await browser.close();
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

export async function testBitPanelConnection(config) {
  return runWithBrowser(config, async (page) => {
    await page.goto(`${config.BITPANEL_BASE_URL}/list`, { waitUntil: 'domcontentloaded' });
    const table = page.locator('table tbody');
    await table.waitFor({ state: 'visible' });
    return { ok: true, message: 'Login confirmado e lista de clientes encontrada.' };
  });
}

export async function fetchBitPanelCustomers(config) {
  return runWithBrowser(config, async (page) => {
    await page.goto(`${config.BITPANEL_BASE_URL}/list`, { waitUntil: 'domcontentloaded' });
    await page.locator('table tbody').waitFor({ state: 'visible' });
    const customers = new Map();

    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const rows = page.locator('table tbody tr');
      const count = await rows.count();
      let firstIdOnPage = '';
      for (let index = 0; index < count; index += 1) {
        const cells = rows.nth(index).locator('td');
        if ((await cells.count()) < 7) continue;
        const id = (await cells.nth(0).innerText()).trim().replace(/^#/, '');
        if (!firstIdOnPage) firstIdOnPage = id;
        const owner = (await cells.nth(2).innerText()).trim();
        const rawStatus = (await cells.nth(3).innerText()).trim();
        const username = (await cells.nth(4).innerText()).trim();
        const expiresText = (await cells.nth(6).innerText()).trim();
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

export async function renewInBitPanel(config, renewal) {
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

  return runWithBrowser(config, async (page) => {
    const listId = String(renewal.bitpanel_list_id);
    const detailsUrl = `${config.BITPANEL_BASE_URL}/list/view/${listId}`;
    await page.goto(detailsUrl, { waitUntil: 'domcontentloaded' });
    const before = await captureListDetails(page);
    if (
      before.expiryDate &&
      renewal.current_expiry &&
      before.expiryDate > renewal.current_expiry
    ) {
      return {
        operation: 'renew',
        simulated: false,
        alreadyRenewed: true,
        beforeExpiry: renewal.current_expiry,
        afterExpiry: before.expiryDate,
        evidencePath: null,
        listId,
        username: before.username
      };
    }

    const row = await findListByUsername(
      page,
      config,
      renewal.bitpanel_reference || before.username
    );
    if (!row || row.id !== listId) {
      throw new Error('Lista não encontrada na busca do BitPanel.');
    }

    const menuIcon = page.locator(`i[title="Mais opções, lista ${listId}"]`);
    if ((await menuIcon.count()) !== 1) {
      throw new Error('Menu de opções da lista não encontrado.');
    }
    await menuIcon.click();
    await page.getByRole('menuitem', { name: 'Renovar', exact: true }).click();

    const dialog = page.locator('.v-dialog--active');
    await dialog.waitFor({ state: 'visible' });
    await selectVuetifyOption(
      page,
      dialog,
      /^Selecione o plano/,
      config.BITPANEL_PLAN_LABEL
    );
    await selectVuetifyOption(
      page,
      dialog,
      /^Selecione a validade/,
      optionLabelForMonths(renewal.duration_months)
    );

    const evidencePath = join(
      config.ARTIFACTS_DIR,
      `${Date.now()}-${safeName(renewal.id)}-renovacao.png`
    );
    await page.screenshot({ path: evidencePath, fullPage: true });
    const renewButton = dialog.getByRole('button', { name: 'Renovar', exact: true });
    if ((await renewButton.count()) !== 1) throw new Error('Botão final de renovação não encontrado.');
    await renewButton.click();
    await dialog.waitFor({ state: 'hidden' });

    await page.goto(detailsUrl, { waitUntil: 'domcontentloaded' });
    const after = await captureListDetails(page);
    if (!after.expiryDate || before.expiryDate === after.expiryDate) {
      throw new Error('A validade não mudou após a renovação.');
    }
    return {
      operation: 'renew',
      simulated: false,
      beforeExpiry: before.expiryDate,
      afterExpiry: after.expiryDate,
      evidencePath,
      listId,
      username: after.username
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
      optionLabelForMonths(renewal.duration_months)
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
