import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { authenticate, grantStepUp, publicUser } from '../src/auth.js';

test('authenticate recusa sessão ausente sem consultar o banco', async () => {
  let queries = 0;
  const db = { query: async () => { queries += 1; return { rows: [] }; } };
  assert.equal(await authenticate(db, { cookies: {} }), null);
  assert.equal(queries, 0);
});

test('authenticate recusa token sem sessão válida', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    }
  };
  assert.equal(await authenticate(db, { cookies: { gate_one_session: 'token-invalido' } }), null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /s\.expires_at > now\(\)/);
});

test('publicUser não expõe o identificador interno da sessão', () => {
  const user = publicUser({
    id: 'user-1',
    name: 'Admin',
    email: 'admin@example.com',
    role: 'admin',
    session_id: 'session-secret',
    step_up_until: null
  });
  assert.deepEqual(user, {
    id: 'user-1',
    name: 'Admin',
    email: 'admin@example.com',
    role: 'admin',
    stepUpUntil: null
  });
  assert.equal('session_id' in user, false);
});

test('grantStepUp valida senha e limita update à sessão do usuário', async () => {
  const passwordHash = await bcrypt.hash('senha-segura', 4);
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT password_hash')) return { rows: [{ password_hash: passwordHash }] };
      return {
        rows: [{
          step_up_until: '2026-08-22T15:10:00.000Z',
          step_up_capability: 'customer.delete'
        }]
      };
    }
  };
  const expires = await grantStepUp(db, {
    userId: 'user-1',
    sessionId: 'session-1',
    password: 'senha-segura',
    capability: 'customer.delete'
  });
  assert.deepEqual(expires, {
    stepUpUntil: '2026-08-22T15:10:00.000Z',
    capability: 'customer.delete'
  });
  assert.deepEqual(calls[1].params, ['session-1', 'user-1', 'customer.delete']);
  assert.match(calls[1].sql, /expires_at > now\(\)/);
});

test('grantStepUp não atualiza sessão com senha inválida', async () => {
  const passwordHash = await bcrypt.hash('correta', 4);
  let updates = 0;
  const db = {
    async query(sql) {
      if (sql.startsWith('SELECT password_hash')) return { rows: [{ password_hash: passwordHash }] };
      updates += 1;
      return { rows: [] };
    }
  };
  const result = await grantStepUp(db, {
    userId: 'user-1',
    sessionId: 'session-1',
    password: 'errada',
    capability: 'customer.delete'
  });
  assert.equal(result, null);
  assert.equal(updates, 0);
});

test('grantStepUp não libera outra sessão do mesmo usuário', async () => {
  const passwordHash = await bcrypt.hash('correta', 4);
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT password_hash')) return { rows: [{ password_hash: passwordHash }] };
      return { rows: [] };
    }
  };
  const result = await grantStepUp(db, {
    userId: 'user-1',
    sessionId: 'session-de-outro-dispositivo',
    password: 'correta',
    capability: 'customer.delete'
  });
  assert.equal(result, null);
  assert.deepEqual(calls[1].params, [
    'session-de-outro-dispositivo',
    'user-1',
    'customer.delete'
  ]);
  assert.match(calls[1].sql, /WHERE id = \$1 AND user_id = \$2 AND expires_at > now\(\)/);
});
