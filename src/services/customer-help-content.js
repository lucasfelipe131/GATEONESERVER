const VERIFIED_AT = '2026-10-12T03:00:00.000Z';
const HOUR = 3_600_000;
const OFFICIAL_HOSTS = ['samsung.com', 'lg.com', 'roku.com', 'smartone-iptv.com', 'bitplatform.vip'];
const RESERVED_TELEGRAM_NAMES = new Set(['s', 'joinchat', 'share', 'proxy', 'login', 'addstickers', 'addemoji', 'iv', 'c']);
const PERSONAL_OR_SECRET = /(?:\b(?:senha|password|passwd|token|api[ _-]?key|access[ _-]?key|usu[aá]rio|username|login)\b\s*[:=]\s*\S+)|(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)|(?:\b\d{3}[. -]\d{3}[. -]\d{3}[- ]\d{2}\b)|(?:\b\d{10,13}\b)|(?:\b(?:55[ .()-]*)?\(?\d{2}\)?[ .-]*\d{4,5}[ .-]*\d{4}\b)/i;

const GUIDE_CONTENT = [
  {
    id: 'samsung', device: 'Samsung', title: 'Instalar na TV Samsung',
    steps: [
      'Conecte a TV à internet e pressione Home no controle remoto.',
      'Abra Apps e use a pesquisa para localizar o aplicativo indicado em Meu acesso.',
      'Confira o nome e o desenvolvedor do aplicativo, selecione Instalar e depois Abrir.',
      'Se a TV pedir, entre na sua Samsung Account. A disponibilidade muda conforme o modelo e a região.',
      'Use os dados de Meu acesso somente no aplicativo indicado. Se ele não estiver na loja, peça ajuda à equipe.'
    ],
    videos: [{ title: 'Samsung Brasil: baixar aplicativos (exemplo de 2015; a interface pode variar)', url: 'https://www.youtube.com/watch?v=uPJHmwS050E' }],
    sourceUrl: 'https://www.samsung.com/br/support/tv-audio-video/como-instalar-e-gerenciar-aplicativos-baixados-na-sua-tv-samsung/'
  },
  {
    id: 'lg', device: 'LG', title: 'Instalar na TV LG',
    steps: [
      'Conecte a TV à internet e pressione Home no controle remoto.',
      'Abra Apps ou LG Content Store e procure o aplicativo indicado em Meu acesso.',
      'Confira o nome e o desenvolvedor, escolha Instalar e abra o aplicativo.',
      'Entre na sua conta LG se solicitado. A disponibilidade depende do modelo, da versão do webOS e da região.',
      'Preencha os dados de Meu acesso somente no aplicativo indicado. Se ele não aparecer na loja, solicite ajuda à equipe.'
    ],
    videos: [{ title: 'LG Brasil: baixar e instalar aplicativos (exemplo de 2021; a interface pode variar)', url: 'https://www.youtube.com/watch?v=31MnkOA4_q0' }],
    sourceUrl: 'https://www.lg.com/br/suporte/suporte-ao-producto/solucionar-problemas/help-library/cs-CT52001752-20154523926069/'
  },
  {
    id: 'roku', device: 'Roku', title: 'Instalar na TV Roku',
    steps: [
      'Pressione Home e abra Canais de streaming ou Loja no menu da TV.',
      'Use a pesquisa para procurar um aplicativo compatível indicado pela equipe para o seu aparelho.',
      'Confira o nome e o desenvolvedor, pressione OK e escolha Adicionar canal ou Adicionar app.',
      'Se o aplicativo não aparecer após a instalação, abra Configurações, Sistema, Atualização do sistema e Verificar agora.',
      'Os aplicativos disponíveis variam. Aplicativos Samsung, LG e arquivos APK não comprovam compatibilidade com Roku; confirme com a equipe antes de comprar ou instalar.'
    ],
    // No manufacturer video was verified for this installation flow.
    videos: [], sourceUrl: 'https://support.roku.com/pt-br/article/add-an-app'
  }
];

function instant(value) {
  if (!(typeof value === 'string' || value instanceof Date || typeof value === 'number')) return null;
  if (value === '' || value === null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function verifiedDate(value, now) {
  const date = instant(value);
  return date && date.getTime() <= now.getTime() ? date : null;
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return null;
  const plain = value.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(plain) || PERSONAL_OR_SECRET.test(plain)) return null;
  const text = plain.replace(/\r\n?/g, '\n').trim();
  return text ? text.slice(0, limit) : null;
}

function normalizedUrl(value) {
  if (typeof value !== 'string' || value.length > 1500 || /[\s\\<>\u0000-\u001f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return null;
    return url;
  } catch { return null; }
}

const hostWithin = (host, root) => host === root || host.endsWith(`.${root}`);
const officialHost = host => OFFICIAL_HOSTS.some(root => hostWithin(host, root));

function officialUrl(value, { bitpanel = false, video = false } = {}) {
  const url = normalizedUrl(value);
  if (!url) return null;
  if (video && ['youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'].includes(url.hostname)) {
    if (url.hostname === 'youtu.be') return /^\/[\w-]{11}$/.test(url.pathname) && !url.search ? url.href : null;
    if (url.pathname === '/watch' && [...url.searchParams.keys()].length === 1 && /^[\w-]{11}$/.test(url.searchParams.get('v') || '')) return url.href;
    if (/^\/embed\/[\w-]{11}$/.test(url.pathname) && !url.search) return url.href;
    return null;
  }
  if (url.search || !officialHost(url.hostname) && !(bitpanel && hostWithin(url.hostname, 'bitpanel.vip'))) return null;
  // Decoding catches credentials hidden in a URL path, not just query strings.
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  if (PERSONAL_OR_SECRET.test(path) || /(?:password|passwd|token|api[_-]?key|access[_-]?key)[/=]/i.test(path)) return null;
  return url.href;
}

function telegramChannel(value) {
  const url = normalizedUrl(value);
  if (!url || url.hostname !== 't.me' || url.search) return null;
  const match = /^\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(url.pathname);
  if (!match || RESERVED_TELEGRAM_NAMES.has(match[1].toLowerCase())) return null;
  return { name: match[1], url: `https://t.me/${match[1]}` };
}

function telegramPostUrl(value, channel) {
  const url = normalizedUrl(value);
  if (!url || url.hostname !== 't.me' || url.search) return null;
  const match = /^\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})\/(\d{1,12})\/?$/.exec(url.pathname);
  if (!match || match[1].toLowerCase() !== channel.name.toLowerCase()) return null;
  return `https://t.me/${channel.name}/${match[2]}`;
}

function verifiedPrivateChannel(item, now) {
  const date = verifiedDate(item?.verifiedAt, now), url = normalizedUrl(item?.channelUrl);
  const sourceUrl = officialUrl(item?.sourceUrl, { bitpanel: true });
  if (!date || !url || url.hostname !== 't.me' || url.search || !/^\/\+[A-Za-z0-9_-]{16,64}$/.test(url.pathname) ||
      !sourceUrl || !hostWithin(new URL(sourceUrl).hostname, 'bitpanel.vip')) return null;
  return url.href;
}

function publicHostname(value) {
  if (typeof value !== 'string' || value.length > 253 || !value.includes('.')) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(value)) return false;
  return value.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
}

function dnsAddress(value) {
  if (typeof value !== 'string' || /[\s\\<>]/.test(value) || value.length > 350) return null;
  if (/^https?:\/\//.test(value)) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !publicHostname(url.hostname)) return null;
    // Provider DNS addresses are data to copy, never links to follow or fetch.
    return value;
  }
  const match = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match || !publicHostname(match[1]) || match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return null;
  return value;
}

function compatibleApp(item, device, now) {
  if (!item || typeof item !== 'object' || String(item.device || '').toLowerCase() !== device.toLowerCase()) return null;
  const name = cleanText(item.name, 80), date = verifiedDate(item.verifiedAt, now);
  const url = officialUrl(item.url), source = officialUrl(item.sourceUrl);
  if (!name || !date || !url || !source) return null;
  const appHost = new URL(url).hostname;
  if (/\b(?:android|apk)\b/i.test(name) || /\.(?:apk|exe|zip|ipk)(?:\/|$)/i.test(new URL(url).pathname)) return null;
  // Source research only confirms SmartOne on Samsung/LG, never Roku.
  if (device === 'Roku' && (!hostWithin(appHost, 'roku.com') || /smart\s*one/i.test(name))) return null;
  if (device !== 'Roku' && hostWithin(appHost, 'roku.com')) return null;
  if (device === 'Samsung' && hostWithin(appHost, 'lg.com') || device === 'LG' && hostWithin(appHost, 'samsung.com')) return null;
  return { name, url };
}

function postCategory(item, content) {
  if (['guides', 'notices', 'news'].includes(item.category)) return item.category;
  const normalized = content.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const guide = /\b(?:guia|tutorial|passo a passo|como instalar|como configurar)\b/.test(normalized);
  const notice = /\b(?:aviso|manutencao|instabilidade|interrupcao|indisponivel|comunicado)\b/.test(normalized);
  return guide && !notice ? 'guides' : notice && !guide ? 'notices' : 'news';
}

function providerPosts(catalog, now) {
  return (Array.isArray(catalog?.posts) ? catalog.posts : []).slice(0, 80).flatMap(item => {
    if (item?.source !== 'bitpanel') return [];
    const content = cleanText(item.content, 5000), sourceUrl = officialUrl(item.url, { bitpanel: true });
    const publishedAt = verifiedDate(item.published_at ?? item.publishedAt, now), verifiedAt = verifiedDate(item.verifiedAt, now);
    if (!content || !sourceUrl || !publishedAt || !verifiedAt) return [];
    const url = new URL(sourceUrl);
    if (!hostWithin(url.hostname, 'bitpanel.vip') || !/^\/(?:notices|news)\/?$/.test(url.pathname)) return [];
    const firstLine = content.split('\n').find(line => line.trim()) || content;
    const title = cleanText(item.title ?? firstLine, 120);
    if (!title) return [];
    return [{ title, content, url: sourceUrl, publishedAt: publishedAt.toISOString(), verifiedAt: verifiedAt.toISOString(),
      category: postCategory(item, `${title}\n${content}`), source: 'BitPanel' }];
  });
}

// This is a presentation boundary only: no network, provider credentials or account data.
export function buildCustomerHelp({ catalog = {}, telegramSync = {}, posts = [], now = new Date() } = {}) {
  const today = instant(now);
  if (!today) throw new TypeError('CUSTOMER_HELP_INVALID_DATE');
  const suggested = Array.isArray(catalog?.sugestedApps) ? catalog.sugestedApps : Array.isArray(catalog?.suggestedApps) ? catalog.suggestedApps : [];
  const guides = GUIDE_CONTENT.map(guide => ({ ...guide, steps: [...guide.steps], videos: guide.videos.map(video => ({ ...video })),
    apps: suggested.slice(0, 50).map(item => compatibleApp(item, guide.device, today)).filter(Boolean).slice(0, 6), verifiedAt: VERIFIED_AT }));
  const explicitlyUnavailable = status => status !== undefined && !['READY', 'current'].includes(status);
  const dnsSourceUnavailable = [catalog?.bitpanelSync?.status, catalog?.bitpanelSync?.dnsStatus,
    catalog?.bitpanel?.status, catalog?.bitpanel?.dnsStatus].some(explicitlyUnavailable);
  const dns = (Array.isArray(catalog?.dns) ? catalog.dns : []).slice(0, 30).flatMap(item => {
    const name = cleanText(item?.name, 80), value = dnsAddress(item?.value), date = verifiedDate(item?.verifiedAt, today);
    const sourceUrl = officialUrl(item?.sourceUrl, { bitpanel: true });
    if (!name || !value || !date || !sourceUrl) return [];
    const stale = today - date > 24 * HOUR || explicitlyUnavailable(item.status) || dnsSourceUnavailable;
    return [{ name, value, status: stale ? 'stale' : 'current', verifiedAt: date.toISOString(), sourceUrl }];
  }).slice(0, 12);
  const lastSuccess = verifiedDate(telegramSync?.lastSuccessAt, today);
  const channel = telegramChannel(telegramSync?.previewUrl) || telegramChannel(telegramSync?.channelUrl) || telegramChannel(telegramSync?.sourceUrl);
  const ready = Boolean(lastSuccess && channel);
  const telegram = { channelUrl: ready ? channel.url : null, lastSuccessAt: ready ? lastSuccess.toISOString() : null,
    status: !ready ? 'unavailable' : today - lastSuccess > 36 * HOUR ? 'stale' : 'current', posts: [] };
  const privateChannel = verifiedPrivateChannel(catalog?.telegram, today);
  if (privateChannel) {
    telegram.channelUrl = privateChannel;
    telegram.lastSuccessAt = null;
    telegram.status = 'private';
  }
  const publicPosts = ready && !privateChannel ? (Array.isArray(posts) ? posts : []).slice(0, 80).flatMap(item => {
    const content = cleanText(item?.content, 5000), url = telegramPostUrl(item?.url, channel);
    const publishedAt = verifiedDate(item?.published_at ?? item?.publishedAt, today);
    if (!content || !url || !publishedAt) return [];
    const firstLine = content.split('\n').find(line => line.trim()) || content;
    return [{ title: firstLine.replace(/\s+/g, ' ').slice(0, 120), content, url,
      publishedAt: publishedAt.toISOString(), verifiedAt: lastSuccess.toISOString(), category: postCategory(item, content), source: 'Telegram' }];
  }) : [];
  telegram.posts = [...providerPosts(catalog, today), ...publicPosts]
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 40);
  return { updatedAt: today.toISOString(), guides, dns, telegram };
}
