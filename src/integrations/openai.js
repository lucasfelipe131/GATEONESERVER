const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

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

function cleanAudioMimeType(value) {
  const mimetype = String(value || 'audio/ogg').split(';')[0].trim().toLowerCase();
  if (mimetype.startsWith('audio/') || mimetype === 'application/ogg') return mimetype;
  return 'audio/ogg';
}

function safeAudioFileName(value, mimetype) {
  const clean = String(value || '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  if (clean && /\.[a-z0-9]{2,5}$/i.test(clean)) return clean;
  const extension = {
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'application/ogg': 'ogg'
  }[mimetype] || 'ogg';
  return `${clean || 'audio-whatsapp'}.${extension}`;
}

export async function transcribeAudio(
  config,
  { audio, mimetype = 'audio/ogg', fileName = 'audio-whatsapp.ogg', language = 'pt' },
  fetchImpl = fetch
) {
  if (!config.OPENAI_API_KEY) throw new Error('Configure a chave da OpenAI no administrador.');
  const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  if (!bytes.length) throw new Error('O áudio recebido está vazio.');
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error('O áudio excede o limite de 12 MB.');

  const type = cleanAudioMimeType(mimetype);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), safeAudioFileName(fileName, type));
  form.append('model', config.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
  form.append('language', String(language || 'pt').slice(0, 10));
  form.append('response_format', 'json');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetchImpl(TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(cleanErrorMessage(body, response.status));
    const text = String(body.text || '').trim();
    if (!text) throw new Error('A OpenAI retornou uma transcrição vazia.');
    return {
      text,
      model: body.model || config.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('A transcrição demorou para responder. Tente novamente.');
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
