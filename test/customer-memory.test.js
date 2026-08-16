import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSupportMessage,
  cleanCustomerName,
  confirmCustomerLogin,
  detectCustomerIssue,
  isProbableCustomerName,
  resolveIntegrationPhone
} from '../src/services/customer-memory.js';

function identityDb({ targetPhone = null } = {}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM conversation_sessions')) {
        return { rows: [{ data: { intent: 'account' } }] };
      }
      if (sql.includes('FROM customers WHERE whatsapp_e164')) {
        return { rows: [{ id: 'temporary-id', whatsapp_e164: '5535986334218' }] };
      }
      if (sql.includes('lower(trim(bitpanel_reference))')) {
        return {
          rows: [{
            id: 'target-id', name: 'Lucas Cliente', bitpanel_reference: 'lucasiptv',
            whatsapp_e164: targetPhone
          }]
        };
      }
      return { rows: [] };
    }
  };
  return {
    queries,
    async transaction(callback) { return callback(client); }
  };
}

test('valida e normaliza o nome informado pelo cliente', () => {
  assert.equal(cleanCustomerName('  lucas   felipe de oliveira '), 'Lucas Felipe De Oliveira');
  assert.equal(isProbableCustomerName('Ana Paula'), true);
  assert.equal(isProbableCustomerName('MENU'), false);
  assert.equal(isProbableCustomerName('3'), false);
});

test('reconhece problemas comuns e produz orientação com continuidade', () => {
  const issue = detectCustomerIssue('A imagem fica travando e carregando toda hora');
  assert.equal(issue.category, 'buffering');
  const message = buildSupportMessage(issue, {
    first_reported_at: '2026-07-20T12:00:00.000Z'
  });
  assert.match(message, /atendimento anterior/i);
  assert.match(message, /roteador/i);
  assert.match(message, /ATENDENTE/);
});

test('não classifica uma escolha normal de pagamento como problema', () => {
  assert.equal(detectCustomerIssue('Quero o plano mensal e pagar por Pix'), null);
});

test('aceita o campo whatsapp usado pelas rotas de confirmação', () => {
  assert.equal(resolveIntegrationPhone({ whatsapp: '553586334218' }), '5535986334218');
  assert.equal(resolveIntegrationPhone({ phone: '5535986334218' }), '5535986334218');
});

test('associa número ao login exato sem exigir uma sessão por nome', async () => {
  const db = identityDb();
  const result = await confirmCustomerLogin(db, {
    whatsapp: '5535986334218', login: 'LucasIPTV'
  });
  assert.equal(result.matched, true);
  assert.equal(result.pendingIntent, 'account');
  assert.ok(db.queries.some(({ sql }) => sql.includes('UPDATE message_logs')));
  assert.ok(db.queries.some(({ sql }) => sql.includes("'confirmed', 'exact_login'")));
});

test('não sobrescreve telefone existente e cria revisão de conflito', async () => {
  const db = identityDb({ targetPhone: '5535999999999' });
  const result = await confirmCustomerLogin(db, {
    whatsapp: '5535986334218', login: 'lucasiptv'
  });
  assert.equal(result.matched, false);
  assert.equal(result.needsReview, true);
  assert.ok(db.queries.some(({ sql }) => sql.includes("'login_already_has_phone'")));
  assert.equal(db.queries.some(({ sql }) => sql.includes('UPDATE message_logs')), false);
});
