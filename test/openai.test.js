import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAIResponse,
  extractResponseText,
  testOpenAIConnection
} from '../src/integrations/openai.js';
import { requestsHumanSupport } from '../src/services/ai-support.js';

test('extrai texto da Responses API sem depender de output_text', () => {
  assert.equal(
    extractResponseText({
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Resposta segura.' }]
        }
      ]
    }),
    'Resposta segura.'
  );
});

test('envia resposta sem armazenamento no provedor e limita a saída', async () => {
  let request;
  const fetchMock = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        id: 'resp_test',
        model: 'gpt-5.6',
        output_text: 'Tudo certo.'
      })
    };
  };
  const result = await createAIResponse(
    {
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-5.6',
      AI_MAX_OUTPUT_TOKENS: 500
    },
    { instructions: 'Responda com segurança.', input: 'Olá' },
    fetchMock
  );
  assert.equal(result.text, 'Tudo certo.');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.store, false);
  assert.equal(request.body.max_output_tokens, 500);
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
});

test('testa a disponibilidade do modelo configurado', async () => {
  const result = await testOpenAIConnection(
    { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-5.6' },
    async (url) => {
      assert.equal(url, 'https://api.openai.com/v1/models/gpt-5.6');
      return { ok: true, json: async () => ({ id: 'gpt-5.6' }) };
    }
  );
  assert.equal(result.ok, true);
});

test('reconhece pedido de atendimento humano', () => {
  assert.equal(requestsHumanSupport('Quero falar com um atendente'), true);
  assert.equal(requestsHumanSupport('Qual o valor do plano mensal?'), false);
});
