const RESPONSES_URL = 'https://api.openai.com/v1/responses';

function cleanErrorMessage(body, status) {
  if (status === 401) return 'A chave da OpenAI foi recusada.';
  if (status === 429) return 'A OpenAI atingiu o limite de uso. Tente novamente em instantes.';
  return body?.error?.message
    ? `A OpenAI recusou a solicitação: ${body.error.message}`
    : `A OpenAI não respondeu corretamente (${status}).`;
}

export function extractResponseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const parts = [];
  for (const item of response?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

export async function createAIResponse(
  config,
  { instructions, input, maxOutputTokens = config.AI_MAX_OUTPUT_TOKENS || 700 },
  fetchImpl = fetch
) {
  if (!config.OPENAI_API_KEY) throw new Error('Configure a chave da OpenAI no administrador.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetchImpl(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.OPENAI_MODEL || 'gpt-5.6',
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        store: false
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(cleanErrorMessage(body, response.status));
    const text = extractResponseText(body);
    if (!text) throw new Error('A OpenAI retornou uma resposta vazia.');
    return {
      id: body.id || null,
      model: body.model || config.OPENAI_MODEL || 'gpt-5.6',
      text
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('A OpenAI demorou para responder. Tente novamente.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function testOpenAIConnection(config, fetchImpl = fetch) {
  if (!config.OPENAI_API_KEY) throw new Error('Informe a chave da OpenAI.');
  const model = config.OPENAI_MODEL || 'gpt-5.6';
  const response = await fetchImpl(
    `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
    { headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` } }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(cleanErrorMessage(body, response.status));
  }
  return { ok: true, model, message: `OpenAI conectada. Modelo ${model} disponível.` };
}
