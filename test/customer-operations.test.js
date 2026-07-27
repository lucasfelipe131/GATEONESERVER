import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('expõe classificação em lote e exclusão protegidas por autenticação', () => {
  assert.match(
    server,
    /app\.patch\('\/api\/admin\/customers\/operational-stage', \{ preHandler: requireAuth \}/
  );
  assert.match(
    server,
    /app\.delete\('\/api\/admin\/customers\/:id', \{ preHandler: requireAuth \}/
  );
});

test('painel permite selecionar, classificar e excluir clientes', () => {
  assert.match(html, /id="selectAllCustomers"/);
  assert.match(html, /id="bulkOperationalStage"/);
  assert.match(app, /data-delete-customer/);
  assert.match(app, /customerIds: \[\.\.\.state\.selectedCustomers\]/);
});
