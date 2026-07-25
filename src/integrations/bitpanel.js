import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

function render(value, variables) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in variables)) throw new Error(`Variável do fluxo BitPanel não encontrada: ${key}`);
    return String(variables[key]);
  });
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

export function parseBitPanelFlow(config) {
  if (!config.BITPANEL_FLOW_JSON) {
    throw new Error('BITPANEL_FLOW_JSON ainda não foi mapeado.');
  }
  let flow;
  try {
    flow = JSON.parse(config.BITPANEL_FLOW_JSON);
  } catch {
    throw new Error('BITPANEL_FLOW_JSON não contém um JSON válido.');
  }
  if (!Array.isArray(flow.steps) || !flow.steps.length) {
    throw new Error('O fluxo BitPanel precisa conter uma lista steps.');
  }
  return flow;
}

export async function renewInBitPanel(config, renewal) {
  if (config.BITPANEL_MODE === 'disabled') throw new Error('Automação BitPanel desativada.');
  if (config.BITPANEL_MODE === 'simulation') {
    return {
      simulated: true,
      beforeExpiry: renewal.current_expiry,
      afterExpiry: renewal.current_expiry,
      evidencePath: null,
      captures: {}
    };
  }
  if (!config.BITPANEL_USERNAME || !config.BITPANEL_PASSWORD) {
    throw new Error('Credenciais do BitPanel não configuradas na Railway.');
  }

  const flow = parseBitPanelFlow(config);
  const variables = {
    baseUrl: config.BITPANEL_BASE_URL,
    loginUrl: config.BITPANEL_LOGIN_URL,
    username: config.BITPANEL_USERNAME,
    password: config.BITPANEL_PASSWORD,
    customerName: renewal.customer_name,
    customerReference: renewal.bitpanel_reference || '',
    listId: renewal.bitpanel_list_id || '',
    planCode: renewal.plan_code,
    durationMonths: renewal.duration_months
  };
  await mkdir(config.ARTIFACTS_DIR, { recursive: true });
  const evidencePath = join(
    config.ARTIFACTS_DIR,
    `${Date.now()}-${safeName(renewal.id)}-final.png`
  );
  const captures = {};
  const browser = await chromium.launch({
    headless: config.BITPANEL_HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    for (const step of flow.steps) {
      const selector = render(step.selector, variables);
      switch (step.type) {
        case 'goto':
          await page.goto(render(step.url, variables), { waitUntil: step.waitUntil || 'domcontentloaded' });
          break;
        case 'fill':
          await page.locator(selector).fill(render(step.value, variables));
          break;
        case 'click':
          await page.locator(selector).click();
          break;
        case 'select':
          await page.locator(selector).selectOption(render(step.value, variables));
          break;
        case 'waitForURL':
          await page.waitForURL(render(step.url, variables));
          break;
        case 'wait':
          await page.waitForTimeout(Math.min(Number(step.ms) || 500, 5_000));
          break;
        case 'captureText':
          captures[step.saveAs] = (await page.locator(selector).innerText()).trim();
          break;
        case 'expectText':
          if (!(await page.locator(selector).innerText()).includes(render(step.text, variables))) {
            throw new Error(`Texto esperado não apareceu: ${step.text}`);
          }
          break;
        case 'assertChanged':
          if (!captures[step.before] || captures[step.before] === captures[step.after]) {
            throw new Error('A validade não mudou após a renovação.');
          }
          break;
        case 'screenshot':
          await page.screenshot({
            path: join(
              config.ARTIFACTS_DIR,
              `${Date.now()}-${safeName(renewal.id)}-${safeName(step.name || 'step')}.png`
            ),
            fullPage: true
          });
          break;
        default:
          throw new Error(`Ação BitPanel não permitida: ${step.type}`);
      }
    }
    await page.screenshot({ path: evidencePath, fullPage: true });
    return {
      simulated: false,
      beforeExpiry: captures.beforeExpiry || null,
      afterExpiry: captures.afterExpiry || null,
      evidencePath,
      captures
    };
  } finally {
    await browser.close();
  }
}
