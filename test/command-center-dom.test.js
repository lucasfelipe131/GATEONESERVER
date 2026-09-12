import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createCommandCenter } from '../public/command-center.js';
import { fixture } from '../scripts/support-fixture.js';
import { MemoryCommandCenter } from '../src/services/command-center.js';

async function domFixture({
  empty = false,
  metricsError = false,
  canManage = true,
} = {}) {
  const f = await fixture({ known: false });
  if (!empty) await f.run();
  const model = new MemoryCommandCenter({
    repository: f.repository,
    context: f.context,
    decisions: f.decisions,
  });
  const dom = new JSDOM(
    await readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    { url: 'http://localhost' },
  );
  const { document } = dom.window;
  // DOM-only harness: these shims do not assert browser layout or native modal behavior.
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const previous = globalThis.FormData;
  globalThis.FormData = dom.window.FormData;
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    const url = new URL(path, 'http://localhost');
    const q = Object.fromEntries(url.searchParams);
    const parts = url.pathname.split('/').filter(Boolean).slice(3);
    if (parts[0] === 'summary') return model.summary();
    if (parts[0] === 'metrics') {
      if (metricsError) throw new Error('SIMULATED');
      return model.metrics();
    }
    if (parts[0] === 'activity') return model.activity(q);
    if (['exceptions', 'cases', 'conversations'].includes(parts[0]))
      return model.list(parts[0], q);
    if (parts[0] === 'customers' && parts.length === 2)
      return model.customer(parts[1]);
    if (parts[0] === 'customers' && parts.length === 4)
      return model.detail(parts[1], parts[3]);
    throw new Error('UNEXPECTED_LOCAL_REQUEST');
  };
  const cc = createCommandCenter({ api, document, canManage: () => canManage });
  return {
    f,
    dom,
    document,
    cc,
    calls,
    close: () => {
      globalThis.FormData = previous;
      dom.window.close();
    },
  };
}
test('phase6 DOM renders dashboard data and all autonomy denominators', async () => {
  const t = await domFixture();
  try {
    await t.cc.dashboard();
    assert.equal(
      t.document.querySelectorAll('#ccSummary .cc-metric').length,
      10,
    );
    assert.match(
      t.document.getElementById('ccMetrics').textContent,
      /0 \/ 1 elegíveis/,
    );
    assert.match(
      t.document.getElementById('ccNeedsYou').textContent,
      /Cliente A sintético/,
    );
  } finally {
    t.close();
  }
});
test('phase6 DOM inbox provides complete empty state and disables next page', async () => {
  const t = await domFixture({ empty: true });
  try {
    await t.cc.inbox();
    assert.match(
      t.document.getElementById('ccInbox').textContent,
      /Nenhuma solicitação precisa/,
    );
    assert.equal(t.document.getElementById('ccNext').disabled, true);
  } finally {
    t.close();
  }
});
test('phase6 DOM metrics error is isolated from summary and inbox', async () => {
  const t = await domFixture({ metricsError: true });
  try {
    await t.cc.dashboard();
    assert.ok(t.document.querySelector('#ccMetrics .cc-error'));
    assert.equal(
      t.document.querySelectorAll('#ccSummary .cc-metric').length,
      10,
    );
    assert.ok(t.document.querySelector('#ccNeedsYou [data-cc-exception]'));
  } finally {
    t.close();
  }
});
test('phase6 DOM filters are sent as constrained query fields', async () => {
  const t = await domFixture();
  try {
    t.document.querySelector('[name="severity"]').value = 'CRITICAL';
    await t.cc.inbox(true);
    assert.match(t.calls.at(-1).path, /severity=CRITICAL/);
    assert.match(
      t.document.getElementById('ccInbox').textContent,
      /Nenhuma solicitação precisa/,
    );
  } finally {
    t.close();
  }
});
test('phase6 DOM exception detail exposes context and safe allowlisted actions', async () => {
  const t = await domFixture();
  try {
    const e = [...t.f.repository.tables.exceptions.values()][0];
    await t.cc.detail(t.f.a, e.id);
    const text = t.document.getElementById('ccExceptionDetail').textContent;
    for (const label of [
      'CLIENTE',
      'PROBLEMA',
      'DIAGNÓSTICO',
      'TENTATIVAS',
      'TOOLS',
      'RESULTADOS',
      'RISCO',
      'RECOMENDAÇÃO',
    ])
      assert.ok(text.includes(label), label);
    assert.equal(t.document.querySelectorAll('[data-cc-action]').length, 4);
  } finally {
    t.close();
  }
});
test('phase6 DOM readonly operator does not receive mutation buttons', async () => {
  const t = await domFixture({ canManage: false });
  try {
    const e = [...t.f.repository.tables.exceptions.values()][0];
    await t.cc.detail(t.f.a, e.id);
    assert.equal(t.document.querySelectorAll('[data-cc-action]').length, 0);
  } finally {
    t.close();
  }
});
test('phase6 DOM customer and conversations display support/exceptions from same projection', async () => {
  const t = await domFixture();
  try {
    await t.cc.customer(t.f.a);
    assert.match(
      t.document.getElementById('ccCustomerDetail').textContent,
      /Customer360.v1/,
    );
    assert.match(
      t.document.getElementById('ccCustomerDetail').textContent,
      /HUMAN REQUIRED/,
    );
    await t.cc.conversations();
    assert.match(
      t.document.getElementById('ccConversations').textContent,
      /SupportAgent/,
    );
  } finally {
    t.close();
  }
});
test('phase6 DOM untrusted summaries are escaped, never executed as markup', async () => {
  const t = await domFixture();
  try {
    const e = [...t.f.repository.tables.exceptions.values()][0];
    e.summary = '<img src=x onerror=alert(1)>';
    await t.f.repository.put('exceptions', e);
    await t.cc.inbox();
    assert.equal(t.document.querySelector('#ccInbox img'), null);
    assert.match(t.document.getElementById('ccInbox').textContent, /<img/);
  } finally {
    t.close();
  }
});
