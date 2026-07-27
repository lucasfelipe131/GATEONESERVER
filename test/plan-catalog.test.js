import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('mantém o catálogo oficial consistente no banco e nas telas públicas', async () => {
  const [seed, landing] = await Promise.all([
    readFile(new URL('../src/seed.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/landing.html', import.meta.url), 'utf8')
  ]);
  const expected = [
    ['monthly', 'Mensal', '3000', 'R$ 30'],
    ['quarterly', 'Trimestral', '8500', 'R$ 85'],
    ['semiannual', 'Semestral', '15000', 'R$ 150'],
    ['annual', 'Anual', '27000', 'R$ 270']
  ];
  for (const [code, name, cents, label] of expected) {
    assert.match(seed, new RegExp(`'${code}', '${name}', \\d+, ${cents}`));
    assert.match(landing, new RegExp(label.replace('$', '\\$')));
  }
});

test('painel oferece link Mercado Pago diretamente na lista de clientes', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="paymentLinkDialog"/);
  assert.match(script, /data-payment-customer/);
  assert.match(script, /\/payment-link/);
});
