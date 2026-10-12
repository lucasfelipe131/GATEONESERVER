import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const baseUrl = process.env.BITPANEL_BASE_URL || 'https://bitpanel.vip';
const outputPath = resolve(process.argv[2] || 'bitpanel-session.json');
const profilePath = resolve('data/bitpanel-auth');
await mkdir(profilePath, { recursive: true });

const context = await chromium.launchPersistentContext(profilePath, {
  headless: false,
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo'
});
const page = context.pages()[0] || await context.newPage();
await page.goto(`${baseUrl.replace(/\/$/, '')}/list`, { waitUntil: 'domcontentloaded' });

output.write('\nFaça o login e resolva o CAPTCHA no navegador aberto.\n');
if (process.argv.includes('--auto')) {
  output.write('A sessão será salva automaticamente quando a lista de clientes estiver visível.\n');
  await page.waitForURL(url => url.origin === new URL(baseUrl).origin && url.pathname === '/list', { timeout: 600_000 });
  await page.locator('table tbody').waitFor({ state: 'visible', timeout: 600_000 });
} else {
  const terminal = createInterface({ input, output });
  await terminal.question('Quando a lista de clientes estiver visível, pressione ENTER aqui... ');
  terminal.close();
}

if (new URL(page.url()).pathname.includes('/login')) {
  await context.close();
  throw new Error('A sessão ainda está na tela de login. Conclua o CAPTCHA antes de salvar.');
}
await page.locator('table tbody').waitFor({ state: 'visible', timeout: 15_000 });
await context.storageState({ path: outputPath });
await context.close();
output.write(`\nSessão criada em: ${outputPath}\nImporte este arquivo em Configurações > BitPanel. Não envie por WhatsApp ou e-mail.\n`);
