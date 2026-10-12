import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerHelp } from '../src/services/customer-help-content.js';

const now = '2026-10-12T12:00:00.000Z';
const verifiedAt = '2026-10-12T10:00:00.000Z';
const sync = { previewUrl: 'https://t.me/s/canalgate', lastSuccessAt: verifiedAt };
const post = (content, id = 1, extra = {}) => ({ content, url: `https://t.me/canalgate/${id}`, published_at: verifiedAt, ...extra });
const app = (device, extra = {}) => ({ device, name: 'SmartOne IPTV', url: 'https://smartone-iptv.com/',
  sourceUrl: 'https://smartone-iptv.com/plugin/support_manager/knowledgebase/', verifiedAt, ...extra });
const dns = extra => ({ name: 'Servidor principal', value: 'stream.gatecustomer.com:443', verifiedAt,
  sourceUrl: 'https://bitpanel.vip/', ...extra });

test('guias oficiais usam vídeos identificados por época e não inventam aplicativos ou DNS', () => {
  const result = buildCustomerHelp({ now });
  assert.equal(result.updatedAt, now);
  assert.deepEqual(result.guides.map(guide => guide.device), ['Samsung', 'LG', 'Roku']);
  assert.match(result.guides[0].videos[0].title, /2015.*interface pode variar/);
  assert.match(result.guides[1].videos[0].title, /2021.*interface pode variar/);
  assert.deepEqual(result.guides[2].videos, []);
  assert.ok(result.guides.every(guide => guide.apps.length === 0 && guide.steps.length > 0 && guide.verifiedAt));
  assert.deepEqual(result.dns, []);
  assert.deepEqual(result.telegram, { channelUrl: null, lastSuccessAt: null, status: 'unavailable', posts: [] });
});

test('aplicativos precisam de fonte, data e compatibilidade do aparelho, sem fallback Roku', () => {
  const catalog = { sugestedApps: [app('Samsung'), app('LG'), app('Roku'), app('Samsung', { verifiedAt: null }),
    app('Samsung', { sourceUrl: 'https://unverified.app/' }), app('Samsung', { device: 'android' }),
    app('Roku', { name: 'Canal aprovado', url: 'https://channelstore.roku.com/details/channel', sourceUrl: 'https://support.roku.com/pt-br/article/add-an-app' })] };
  const result = buildCustomerHelp({ catalog, now });
  assert.deepEqual(result.guides[0].apps, [{ name: 'SmartOne IPTV', url: 'https://smartone-iptv.com/' }]);
  assert.equal(result.guides[1].apps.length, 1);
  assert.deepEqual(result.guides[2].apps, [{ name: 'Canal aprovado', url: 'https://channelstore.roku.com/details/channel' }]);
  assert.equal(buildCustomerHelp({ catalog: { suggestedApps: [app('Samsung')] }, now }).guides[0].apps.length, 1);
});

test('URLs não autorizadas, com credenciais, dados pessoais, esquemas ou consultas sensíveis são rejeitadas', () => {
  const urls = ['javascript:alert(1)', 'data:text/html,secret', 'http://smartone-iptv.com/',
    'https://smartone-iptv.com.evil.test/', 'https://user:secret@smartone-iptv.com/',
    'https://smartone-iptv.com/?token=secret', 'https://smartone-iptv.com/password/secret',
    'https://smartone-iptv.com/%74oken/secret', 'https://127.0.0.1/', 'https://localhost/',
    'https://smartone-iptv.com/#customer-secret', 'https://smartone-iptv.com/5511998765432'];
  const result = buildCustomerHelp({ catalog: { sugestedApps: urls.map(url => app('Samsung', { url })) }, now });
  assert.deepEqual(result.guides[0].apps, []);
  assert.equal(JSON.stringify(result).includes('customer-secret'), false);
});

test('DNS só publica origem verificada e nunca considera dados antigos atuais', () => {
  const catalog = { dns: [dns(), dns({ name: 'Alternativo', value: 'https://stream.gatecustomer.com:8443', verifiedAt: '2026-10-11T10:00:00Z', status: 'current' }),
    dns({ verifiedAt: null }), dns({ verifiedAt: '2026-10-13T10:00:00Z' }), dns({ sourceUrl: null }), dns({ sourceUrl: 'https://private-source.net/' }),
    dns({ value: 'https://customer:secret@stream.gatecustomer.com/' }), dns({ value: 'https://stream.gatecustomer.com/?username=Ana&password=secret' }),
    dns({ value: 'ftp://stream.gatecustomer.com/' }), dns({ value: '127.0.0.1:80' }), dns({ value: '192.168.1.20:80' }),
    dns({ value: 'localhost:443' }), dns({ value: 'stream.internal:443' }), dns({ value: 'stream.gatecustomer.com:65536' })] };
  const result = buildCustomerHelp({ catalog, now });
  assert.equal(result.dns.length, 2);
  assert.equal(result.dns[0].status, 'current');
  assert.equal(result.dns[1].status, 'stale');
  assert.equal(result.dns[1].value, 'https://stream.gatecustomer.com:8443');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('verificação recente não promove DNS marcado indisponível ou sincronização BitPanel que falhou', () => {
  for (const status of ['STALE', 'REAUTH_REQUIRED', 'UNVERIFIED_LINK', 'UNAVAILABLE', 'unknown', null]) {
    const result = buildCustomerHelp({ catalog: { dns: [dns({ status })] }, now });
    assert.equal(result.dns[0].status, 'stale');
  }
  for (const status of ['REAUTH_REQUIRED', 'STALE', 'UNAVAILABLE']) {
    const result = buildCustomerHelp({ catalog: { dns: [dns({ status: 'READY' })], bitpanelSync: { status } }, now });
    assert.equal(result.dns[0].status, 'stale');
  }
  for (const key of ['bitpanel', 'bitpanelSync']) {
    const result = buildCustomerHelp({ catalog: { dns: [dns()], [key]: { status: 'READY', dnsStatus: 'STALE' } }, now });
    assert.equal(result.dns[0].status, 'stale');
  }
  const ready = buildCustomerHelp({ catalog: { dns: [dns({ status: 'READY' })], bitpanelSync: { status: 'READY' } }, now });
  assert.equal(ready.dns[0].status, 'current');
});

test('Telegram categoriza conservadoramente e aceita campos snake_case sem divulgar identidade', () => {
  const raw = [post('Tutorial: como instalar na TV\nConfira o passo a passo.', 1), post('Aviso de manutenção hoje', 2),
    post('Novo filme disponível', 3), post('Tutorial e aviso de manutenção', 4), post('Uma publicação comum', 5, { category: 'notices' }),
    post('Contato cliente@private.com', 6), post('Login: ana senha: segredo', 7), post('WhatsApp 55 11 99876-5432', 8),
    post('<script>alert("payload")</script>', 9), post('DNS configurado', 10, { url: 'https://t.me/anotherchannel/10' }),
    post('Novidade', 11, { url: 'https://t.me/canalgate/11?token=secret' })];
  const result = buildCustomerHelp({ telegramSync: sync, posts: raw, now });
  assert.equal(result.telegram.channelUrl, 'https://t.me/canalgate');
  assert.equal(result.telegram.status, 'current');
  assert.deepEqual(result.telegram.posts.map(item => item.category), ['guides', 'notices', 'news', 'news', 'notices']);
  assert.equal(result.telegram.posts[0].publishedAt, verifiedAt);
  for (const privateValue of ['private.com', 'segredo', '99876', 'payload', 'anotherchannel', 'token=']) assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test('Telegram inválido não publica canal e conteúdo; sincronização antiga é indicada como antiga', () => {
  for (const previewUrl of ['https://t.me/+invite', 'https://t.me/joinchat', 'https://t.me/canalgate?token=secret', 'https://t.me.evil.test/canalgate', 'https://user:pass@t.me/canalgate', 'https://127.0.0.1/canalgate']) {
    const result = buildCustomerHelp({ telegramSync: { previewUrl, lastSuccessAt: verifiedAt }, posts: [post('Novidades')], now });
    assert.equal(result.telegram.status, 'unavailable');
    assert.deepEqual(result.telegram.posts, []);
  }
  const result = buildCustomerHelp({ telegramSync: { ...sync, lastSuccessAt: '2026-10-10T12:00:00Z' }, posts: [post('Novidades')], now });
  assert.equal(result.telegram.status, 'stale');
  assert.equal(result.telegram.posts.length, 1);
});

test('canal privado indicado no BitPanel exige verificação e é somente link, sem espelhar publicações', () => {
  const telegram = { channelUrl: 'https://t.me/+OkM9So6d9npjODRh', verifiedAt, sourceUrl: 'https://bitpanel.vip/' };
  const result = buildCustomerHelp({ catalog: { telegram }, telegramSync: sync, posts: [post('Publicação antiga')], now });
  assert.deepEqual(result.telegram, { channelUrl: telegram.channelUrl, lastSuccessAt: null, status: 'private', posts: [] });
  for (const extra of [{ verifiedAt: null }, { verifiedAt: '2026-10-13T00:00:00Z' }, { sourceUrl: 'https://unverified.net/' },
    { sourceUrl: 'https://samsung.com/' }, { channelUrl: 'https://t.me/+OkM9So6d9npjODRh?token=secret' }]) {
    const unsafe = buildCustomerHelp({ catalog: { telegram: { ...telegram, ...extra } }, now });
    assert.equal(unsafe.telegram.status, 'unavailable');
    assert.equal(unsafe.telegram.channelUrl, null);
  }
});

test('DNS HTTP confirmado pelo fornecedor preserva texto e não permite caminhos ou credenciais', () => {
  const result = buildCustomerHelp({ catalog: { dns: [dns({ value: 'http://auth.urlcld.com', sourceUrl: 'https://bitpanel.vip/notices' }),
    dns({ value: 'http://auth.urlcld.com/?token=secret' }), dns({ value: 'http://user:secret@auth.urlcld.com' }),
    dns({ value: 'http://auth.urlcld.com/customer/playlist' }), dns({ value: 'http://192.168.1.3' })] }, now });
  assert.deepEqual(result.dns, [{ name: 'Servidor principal', value: 'http://auth.urlcld.com', status: 'current', verifiedAt, sourceUrl: 'https://bitpanel.vip/notices' }]);
});

test('avisos autenticados do BitPanel aparecem com origem correta sem simular sincronização privada', () => {
  const item = { source: 'bitpanel', title: 'Aviso do servidor', content: 'DNS mais recente disponível em Meu acesso.',
    url: 'https://bitpanel.vip/notices', publishedAt: '2026-10-08T12:00:00Z', verifiedAt, category: 'notices' };
  const catalog = { telegram: { channelUrl: 'https://t.me/+OkM9So6d9npjODRh', verifiedAt, sourceUrl: 'https://bitpanel.vip/' },
    posts: [item, { ...item, source: 'telegram' }, { ...item, verifiedAt: null }, { ...item, url: 'https://bitpanel.vip/notices/delete' },
      { ...item, content: 'Senha: segredo' }, { ...item, url: 'https://evil.example/notices' },
      { ...item, url: 'https://bitpanel.vip/news', title: 'Novidades do catálogo', category: 'news' }] };
  const result = buildCustomerHelp({ catalog, telegramSync: sync, posts: [post('Canal privado não deve espelhar')], now });
  assert.equal(result.telegram.status, 'private');
  assert.equal(result.telegram.lastSuccessAt, null);
  assert.equal(result.telegram.posts.length, 2);
  assert.deepEqual(result.telegram.posts.map(value => value.source), ['BitPanel', 'BitPanel']);
  assert.deepEqual(result.telegram.posts.map(value => value.category), ['notices', 'news']);
  assert.equal(JSON.stringify(result).includes('Canal privado não deve espelhar'), false);
  assert.equal(JSON.stringify(result).includes('segredo'), false);
});

test('função é pura, limita conteúdo e não retorna objetos secretos fornecidos no catálogo', () => {
  const input = { catalog: { sugestedApps: [app('Samsung', { password: 'private-password' })], dns: [dns({ password: 'private-password' })] },
    telegramSync: { ...sync, token: 'private-token' }, posts: [post('Novidade', 1, { customer_id: 'private-id' })], now };
  const before = JSON.stringify(input);
  const result = buildCustomerHelp(input);
  result.guides[0].steps.push('Alteração na cópia');
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(buildCustomerHelp({ now }).guides[0].steps.includes('Alteração na cópia'), false);
  assert.throws(() => buildCustomerHelp({ now: 'invalid date' }), /CUSTOMER_HELP_INVALID_DATE/);
});
