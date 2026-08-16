import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret } from '../src/security.js';
import { saveBitPanelStorageState } from '../src/integrations/runtime-config.js';

test('protege a sessão autenticada do BitPanel antes de salvar', async () => {
  let stored;
  const db = {
    async query(sql, params) {
      if (sql.startsWith('SELECT encrypted_value')) return { rows: [] };
      stored = params[1];
      return { rows: [] };
    }
  };
  const state = { cookies: [{ name: 'session', value: 'segredo' }], origins: [] };
  await saveBitPanelStorageState(db, { COOKIE_SECRET: 'chave-de-teste' }, state, null);
  assert.ok(stored.startsWith('v1.'));
  assert.equal(stored.includes('segredo'), false);
  const decoded = JSON.parse(decryptSecret(stored, 'chave-de-teste'));
  assert.deepEqual(JSON.parse(decoded.BITPANEL_STORAGE_STATE), state);
});

test('recusa arquivo que não possui o formato de sessão do navegador', async () => {
  const db = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    saveBitPanelStorageState(db, { COOKIE_SECRET: 'x' }, { cookies: [] }),
    /Arquivo de sessão inválido/
  );
});
