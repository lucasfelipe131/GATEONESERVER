import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createNavigation } from '../public/navigation.js';

async function setup(matches = true) {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
  const { document } = dom.window;
  let changed;
  const media = { matches, addEventListener: (_, fn) => { changed = fn; } };
  dom.window.matchMedia = () => media;
  const navigation = createNavigation({ document });
  return { dom, document, navigation, resize: (value) => { media.matches = value; changed(); } };
}
test('responsive navigation closes by button, backdrop and Escape and restores focus', async () => {
  const t = await setup();
  try {
    const get = (id) => t.document.getElementById(id);
    assert.equal(get('sidebar').inert, true);
    for (const method of ['button', 'backdrop', 'escape']) {
      get('menuButton').click();
      assert.equal(get('sidebar').inert, false);
      assert.equal(t.document.querySelector('main').inert, true);
      assert.equal(get('menuButton').getAttribute('aria-expanded'), 'true');
      assert.equal(t.document.activeElement, get('menuClose'));
      if (method === 'button') get('menuClose').click();
      if (method === 'backdrop') get('menuBackdrop').click();
      if (method === 'escape') t.document.dispatchEvent(new t.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.equal(get('sidebar').inert, true);
      assert.equal(t.document.querySelector('main').inert, false);
      assert.equal(get('menuBackdrop').hidden, true);
      assert.equal(t.document.activeElement, get('menuButton'));
      assert.equal(get('menuButton').getAttribute('aria-expanded'), 'false');
    }
  } finally { t.dom.window.close(); }
});
test('responsive navigation traps focus only while open and restores desktop navigation on resize', async () => {
  const t = await setup();
  try {
    const get = (id) => t.document.getElementById(id);
    get('menuButton').click();
    get('logoutButton').focus();
    t.document.dispatchEvent(new t.dom.window.KeyboardEvent('keydown', { key: 'Tab' }));
    assert.equal(t.document.activeElement, get('menuClose'));
    t.document.dispatchEvent(new t.dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
    assert.equal(t.document.activeElement, get('logoutButton'));
    t.resize(false);
    assert.equal(get('sidebar').inert, false);
    assert.equal(get('sidebar').classList.contains('open'), false);
    assert.equal(t.document.body.classList.contains('menu-open'), false);
    t.resize(true);
    assert.equal(get('sidebar').inert, true);
  } finally { t.dom.window.close(); }
});
