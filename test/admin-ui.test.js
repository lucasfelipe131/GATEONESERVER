import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('todos os IDs usados pelo painel existem no HTML e não se repetem', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const referencedIds = [...script.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map(
    (match) => match[1]
  );
  const missing = [...new Set(referencedIds)].filter((id) => !htmlIds.includes(id));
  const duplicated = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
  assert.deepEqual(missing, []);
  assert.deepEqual([...new Set(duplicated)], []);
});

test('dashboard contém gráficos e o assistente possui aviso de segurança', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="revenueChart"/);
  assert.match(html, /id="chargeChart"/);
  assert.match(html, /id="expirationChart"/);
  assert.match(html, /A IA não aprova pagamentos nem executa renovações/);
});
