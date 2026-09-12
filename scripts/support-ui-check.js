import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright';
import { fixture } from './support-fixture.js';
import {
  MemoryCommandCenter,
  registerCommandCenter,
} from '../src/services/command-center.js';

if (process.env.NODE_ENV !== 'test')
  throw new Error(
    'UI checks require NODE_ENV=test; synthetic local harness only.',
  );
const output = resolve(process.env.GATE_UI_OUTPUT || '../phase6-evidence');
await mkdir(output, { recursive: true });
const f = await fixture();
await f.run();
for (const [id, probe] of f.repository.tables.probes)
  if (probe.customer_id === f.b) f.repository.tables.probes.delete(id);
await f.run('não está funcionando', f.b);
const model = new MemoryCommandCenter({
  repository: f.repository,
  context: f.context,
  decisions: f.decisions,
});
const app = Fastify();
registerCommandCenter(app, {
  readModel: model,
  operations: f.operations,
  protect: () => async (req) => {
    req.user = { id: 'synthetic-ui-admin', role: 'admin' };
  },
});
const publicDir = resolve('public');
await app.register(fastifyStatic, { root: publicDir, index: false });
app.get('/', async (_, reply) =>
  reply
    .type('text/html')
    .send(
      (await readFile(resolve(publicDir, 'index.html'), 'utf8')).replace(
        'src="/app.js"',
        'src="/phase6-preview.js"',
      ),
    ),
);
app.get('/phase6-preview.js', async (_, reply) =>
  reply.type('text/javascript').send(`
  import {createCommandCenter} from '/command-center.js';
  const api=async(path,options={})=>{const r=await fetch(path,{...options,headers:{'Content-Type':'application/json'}});if(!r.ok)throw new Error('Falha simulada');return r.json();};
  const cc=createCommandCenter({api,navigate,canManage:()=>true});
  async function navigate(page){document.querySelectorAll('.page').forEach(e=>e.classList.toggle('active',e.dataset.pagePanel===page));document.querySelectorAll('.nav-item').forEach(e=>e.classList.toggle('active',e.dataset.page===page));document.getElementById('sidebar').classList.remove('open');document.getElementById('pageTitle').textContent=page==='exceptions'?'Precisa de Você':'GATE Command Center';
    if(page==='dashboard')await cc.dashboard();if(page==='exceptions')await cc.inbox(true);if(page==='customers')await cc.cases();if(page==='conversations')await cc.conversations();}
  document.getElementById('loginShell').classList.add('hidden');document.getElementById('appShell').classList.remove('hidden');
  document.getElementById('safetyBadge').textContent='SINTÉTICO · LOCAL';
  document.getElementById('menuButton').onclick=()=>document.getElementById('sidebar').classList.toggle('open');
  document.addEventListener('click',e=>{const b=e.target.closest('[data-page],[data-go]');if(b)navigate(b.dataset.page||b.dataset.go);});
  window.phase6={cc,navigate};await navigate('dashboard');
`),
);
const base = await app.listen({ port: 0, host: '127.0.0.1' });
let browser;
let checks = 0;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['tablet', 820, 1180],
    ['mobile', 390, 844],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.locator('#ccSummary .cc-metric').first().waitFor();
    await page.waitForFunction(() =>
      document.querySelector('#ccNeedsYou [data-cc-exception]'),
    );
    assert.equal(await page.locator('#ccSummary .cc-metric').count(), 10);
    checks++;
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `${name} dashboard overflow`,
    );
    checks++;
    await page.screenshot({
      path: resolve(output, `command-center-${name}.png`),
      fullPage: true,
    });
    await page.evaluate(() => window.phase6.navigate('exceptions'));
    await page.locator('#ccInbox [data-cc-exception]').waitFor();
    await page.screenshot({
      path: resolve(output, `exception-inbox-${name}.png`),
      fullPage: true,
    });
    await page.locator('#ccInbox [data-cc-exception]').first().click();
    await page.locator('#ccHumanNote').waitFor();
    assert.ok(
      await page
        .locator('#ccExceptionDetail')
        .textContent()
        .then(
          (t) =>
            t.includes('DIAGNÓSTICO') &&
            t.includes('RISCO') &&
            t.includes('RECOMENDAÇÃO'),
        ),
    );
    checks++;
    assert.equal(
      await page.evaluate(() => {
        const d = document.getElementById('ccDetailDialog');
        return d.scrollWidth <= d.clientWidth;
      }),
      true,
      `${name} dialog overflow`,
    );
    checks++;
    await page.screenshot({
      path: resolve(output, `exception-detail-${name}.png`),
      fullPage: true,
    });
    await page.locator('#ccExceptionDetail [data-cc-customer]').click();
    await page.locator('#ccCustomerDetail h2').waitFor();
    assert.ok(
      (await page.locator('#ccCustomerDetail').textContent()).includes(
        'Customer360.v1',
      ),
    );
    checks++;
    await page.screenshot({
      path: resolve(output, `customer360-${name}.png`),
      fullPage: true,
    });
    await page.locator('[data-cc-close="ccCustomerDialog"]').click();
    await page.evaluate(() => window.phase6.navigate('conversations'));
    await page.locator('#ccConversations .cc-row').first().waitFor();
    assert.ok(
      (await page.locator('#ccConversations').textContent()).includes(
        'SupportAgent',
      ),
    );
    checks++;
    await page.screenshot({
      path: resolve(output, `conversations-${name}.png`),
      fullPage: true,
    });
    await page.evaluate(() => window.phase6.navigate('exceptions'));
    await page.locator('#ccFilters [name="severity"]').selectOption('CRITICAL');
    await page.locator('#ccFilters button').click();
    await page.waitForFunction(() =>
      document
        .querySelector('#ccInbox')
        .textContent.includes('Nenhuma solicitação precisa'),
    );
    checks++;
    await page.route('**/command-center/metrics', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{}',
      }),
    );
    await page.evaluate(() => window.phase6.navigate('dashboard'));
    await page.locator('#ccMetrics .cc-error').waitFor();
    assert.equal(await page.locator('#ccSummary .cc-metric').count(), 10);
    checks++;
    assert.deepEqual(errors, []);
    checks++;
    await page.close();
  }
  console.log(
    `UI PASS: ${checks} assertions; desktop 1440, tablet 820, mobile 390; 15 screenshots; local synthetic HTTP only.`,
  );
} finally {
  await browser?.close();
  await app.close();
}
