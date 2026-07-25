import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BITPANEL_LOGIN_SELECTORS,
  bitPanelOperationFor,
  buildBitPanelUsername,
  parseBitPanelExpiry,
  resolveBitPanelLoginUrl
} from '../src/integrations/bitpanel.js';

test('gera usuário estável e compatível com o BitPanel', () => {
  assert.equal(
    buildBitPanelUsername('João da Silva', '4d9dfda1-3bb8-4c9e-a9bd-123456'),
    'joaodasilva123456'
  );
  assert.equal(buildBitPanelUsername('Á É Í', 'ABC-999'), 'aeiabc999');
});

test('converte a validade exibida pelo BitPanel para data ISO', () => {
  assert.equal(parseBitPanelExpiry('Data de validade: 16/08/2026 18:42'), '2026-08-16');
  assert.equal(parseBitPanelExpiry('sem data'), null);
});

test('separa cadastro novo de renovação existente', () => {
  assert.equal(
    bitPanelOperationFor({ charge_stage: 'new_sale', bitpanel_list_id: null }),
    'provision'
  );
  assert.equal(
    bitPanelOperationFor({ charge_stage: 'manual', bitpanel_list_id: '5308987' }),
    'renew'
  );
  assert.equal(
    bitPanelOperationFor({ charge_stage: 'manual', bitpanel_list_id: null }),
    'provision'
  );
});

test('aceita o login atual por username e corrige a URL raiz do BitPanel', () => {
  assert.match(BITPANEL_LOGIN_SELECTORS.username, /name='username'/);
  assert.match(BITPANEL_LOGIN_SELECTORS.username, /name='email'/);
  assert.equal(
    resolveBitPanelLoginUrl('https://bitpanel.vip', 'https://bitpanel.vip'),
    'https://bitpanel.vip/login'
  );
  assert.equal(
    resolveBitPanelLoginUrl('https://bitpanel.vip', 'https://bitpanel.vip/login'),
    'https://bitpanel.vip/login'
  );
});
