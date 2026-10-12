import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBitPanelPublishedDate } from '../src/integrations/bitpanel-date.js';
import { parseBitPanelCustomerNotices } from '../src/integrations/bitpanel.js';

test('BitPanel publication dates support the current Portuguese label and numeric legacy', () => {
  assert.equal(parseBitPanelPublishedDate('Publicado por: Admin BIT, qui, 8 de out de 2026 às 00:13'), '2026-10-08T00:13:00-03:00');
  assert.equal(parseBitPanelPublishedDate('Publicado por: Admin BIT, seg, 5 de out de 2026 às 22:39'), '2026-10-05T22:39:00-03:00');
  assert.equal(parseBitPanelPublishedDate('Por Equipe — 08/10/2026 00:13'), '2026-10-08T00:13:00-03:00');
  assert.equal(parseBitPanelPublishedDate('Publicado por Equipe 08/10/2026 às 23:59'), '2026-10-08T23:59:00-03:00');
  assert.equal(parseBitPanelPublishedDate('8 de outubro de 2026'), '2026-10-08T00:00:00-03:00');
  assert.equal(parseBitPanelPublishedDate('08/10/2026'), '2026-10-08T00:00:00-03:00');
});

test('BitPanel Portuguese month names are exact, including abbreviations and March accents', () => {
  const months = [['jan', 'janeiro'], ['fev', 'fevereiro'], ['mar', 'março'], ['abr', 'abril'], ['mai', 'maio'], ['jun', 'junho'],
    ['jul', 'julho'], ['ago', 'agosto'], ['set', 'setembro'], ['out', 'outubro'], ['nov', 'novembro'], ['dez', 'dezembro']];
  months.forEach((names, index) => names.forEach(name => {
    assert.equal(parseBitPanelPublishedDate(`1 de ${name} de 2026 às 03:04`), `2026-${String(index + 1).padStart(2, '0')}-01T03:04:00-03:00`);
  }));
  assert.equal(parseBitPanelPublishedDate('29 de FEV. de 2024 às 12:15'), '2024-02-29T12:15:00-03:00');
});

test('BitPanel publication dates reject invalid calendars, malformed hours, English and ambiguous suffixes', () => {
  for (const value of ['29 de fev de 2026 às 00:13', '31 de abr de 2026', '0 de out de 2026', '32 de out de 2026',
    '8 de out de 2009', '8 de out de 2101', '08/14/2026', '32/10/2026', '29/02/2026',
    '8 de out de 2026 às 24:00', '8 de out de 2026 às 00:60', '8 de out de 2026 às 1:03', '8 de out de 2026 às 00:13:59',
    '8 de out de 2026 às', '8 de out de 2026 às 00:13 UTC', '8 de out de 2026 at 00:13', '8 October 2026 00:13',
    '8 de oct de 2026 às 00:13', '8 de october de 2026', '8 de outlier de 2026', '08/10/2026 foo 00:13',
    '08/10/2026 24:00', '08/10/2026 00:60', '08/10/2026 00:13 trailing', '08/10/2026 e 09/10/2026', '', null]) {
    assert.equal(parseBitPanelPublishedDate(value), null, String(value));
  }
  assert.equal(parseBitPanelPublishedDate('1 de jan de 2010'), '2010-01-01T00:00:00-03:00');
  assert.equal(parseBitPanelPublishedDate('31 de dez de 2100 às 23:59'), '2100-12-31T23:59:00-03:00');
});

test('Portuguese provider dates preserve newest DNS precedence and separate notices from news', () => {
  const result = parseBitPanelCustomerNotices([
    {title: 'Atualização', publishedLabel: 'Publicado por: Admin BIT, qui, 8 de out de 2026 às 00:13', content: 'Utilize a nova DNS: http://auth.urlcld.com'},
    {title: 'Anterior', publishedLabel: 'Publicado por: Admin BIT, seg, 5 de out de 2026 às 22:39', content: 'Utilize a nova DNS: http://auth.urlsync.gy'}
  ]);
  assert.equal(result.notices[0].publishedAt, '2026-10-08T00:13:00-03:00');
  assert.equal(result.dns[0].url, 'http://auth.urlcld.com/');
  assert.equal(result.dns[0].sourceUrl, 'https://bitpanel.vip/notices');
  assert.equal(parseBitPanelCustomerNotices([{title: 'Nova orientação', publishedLabel: '9 de out de 2026 às 08:00',
    content: 'Utilize a nova DNS: consulte a equipe'}, {title: 'Anterior', publishedLabel: '8 de out de 2026 às 00:13',
    content: 'Utilize a nova DNS: http://auth.urlcld.com'}]).dnsVerified, false);
  const news = parseBitPanelCustomerNotices([{title: 'Notícia', publishedLabel: 'Publicado por: Admin BIT, seg, 5 de out de 2026 às 22:39',
    content: 'Utilize a nova DNS: http://auth.urlcld.com'}], {sourceUrl: 'https://bitpanel.vip/news', category: 'news'});
  assert.equal(news.notices[0].category, 'news');
  assert.equal(news.notices[0].publishedAt, '2026-10-05T22:39:00-03:00');
  assert.deepEqual(news.dns, []);
});
