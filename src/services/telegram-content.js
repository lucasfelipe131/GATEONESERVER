const DEFAULT_SOURCE = 'https://bit.ly/telebit2';

function decodeHtml(value) {
  const entities = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"'
  };
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => entities[name.toLowerCase()] ?? match);
}

function textFromHtml(value) {
  return decodeHtml(
    String(value || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseTelegramPreview(html) {
  const source = String(html || '');
  const starts = [...source.matchAll(/<div[^>]+class="[^"]*tgme_widget_message_wrap[^"]*"[^>]*>/gi)]
    .map((match) => match.index);
  return starts
    .map((start, index) => source.slice(start, starts[index + 1] ?? source.length))
    .map((block) => {
      const post = block.match(/data-post="([^"]+)"/i)?.[1];
      if (!post) return null;
      const textHtml = block.match(
        /<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]+class="[^"]*tgme_widget_message_footer|<a[^>]+class="[^"]*tgme_widget_message_date)/i
      )?.[1];
      const content = textFromHtml(textHtml);
      const publishedAt = block.match(/<time[^>]+datetime="([^"]+)"/i)?.[1] || null;
      if (!content) return null;
      return {
        sourcePostId: post,
        content,
        url: `https://t.me/${post}`,
        publishedAt
      };
    })
    .filter(Boolean);
}

async function fetchWithTimeout(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; GateOneContentBot/1.0; +https://gateoneserver-production.up.railway.app)'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function telegramPreviewUrl(url) {
  const parsed = new URL(url);
  if (!/(^|\.)t\.me$/i.test(parsed.hostname)) {
    throw new Error('O link configurado não redirecionou para um canal do Telegram.');
  }
  if (parsed.pathname.startsWith('/+')) {
    throw new Error('O canal do Telegram é privado. Use o link público t.me/nome_do_canal.');
  }
  const channel = parsed.pathname.replace(/^\/s\//, '').replace(/^\/+|\/+$/g, '').split('/')[0];
  if (!channel || channel === 'joinchat') {
    throw new Error('Não foi possível identificar o nome público do canal do Telegram.');
  }
  return `https://t.me/s/${channel}`;
}

export async function syncTelegramContent(db, { sourceUrl = DEFAULT_SOURCE } = {}) {
  const resolved = await fetchWithTimeout(sourceUrl);
  if (!resolved.ok) throw new Error(`A fonte do Telegram respondeu com HTTP ${resolved.status}.`);
  const previewUrl = telegramPreviewUrl(resolved.url);
  const preview = resolved.url === previewUrl ? resolved : await fetchWithTimeout(previewUrl);
  if (!preview.ok) throw new Error(`O canal do Telegram respondeu com HTTP ${preview.status}.`);
  const posts = parseTelegramPreview(await preview.text()).slice(-40);
  if (!posts.length) {
    throw new Error('Nenhuma publicação pública foi encontrada no canal do Telegram.');
  }
  let inserted = 0;
  for (const post of posts) {
    const result = await db.query(
      `INSERT INTO content_updates
        (source, source_post_id, content, url, published_at, fetched_at)
       VALUES ('telegram', $1, $2, $3, COALESCE($4::timestamptz, now()), now())
       ON CONFLICT (source, source_post_id) DO UPDATE
         SET content = EXCLUDED.content, url = EXCLUDED.url,
             published_at = EXCLUDED.published_at, fetched_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [post.sourcePostId, post.content.slice(0, 5000), post.url, post.publishedAt]
    );
    if (result.rows[0]?.inserted) inserted += 1;
  }
  await db.query(
    `INSERT INTO system_settings (key, value)
     VALUES ('telegram_content_sync', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [
      JSON.stringify({
        sourceUrl,
        previewUrl,
        lastSuccessAt: new Date().toISOString(),
        postsSeen: posts.length,
        postsInserted: inserted
      })
    ]
  );
  return { sourceUrl, previewUrl, seen: posts.length, inserted };
}

export async function latestTelegramContent(db, limit = 6) {
  const result = await db.query(
    `SELECT source_post_id, content, url, published_at
       FROM content_updates
      WHERE source = 'telegram'
      ORDER BY published_at DESC, created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || 6, 10))]
  );
  return result.rows;
}

function oneLine(value, max = 190) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function formatTelegramDigest(posts) {
  if (!posts?.length) {
    return 'Ainda não há novidades sincronizadas. A fonte do Telegram será consultada novamente na atualização diária.';
  }
  return [
    '📺 *Novidades do Gate One Pro*',
    '',
    ...posts.slice(0, 6).flatMap((post) => [
      `• ${oneLine(post.content)}`,
      post.url || '',
      ''
    ]),
    'Conteúdo atualizado diariamente a partir do canal informado pelo Gate One.'
  ]
    .filter((line, index, all) => line || all[index - 1] !== '')
    .join('\n')
    .trim();
}
