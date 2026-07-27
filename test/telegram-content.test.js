import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTelegramDigest,
  parseTelegramPreview
} from '../src/services/telegram-content.js';

test('extrai publicações da visualização pública do Telegram', () => {
  const html = `
    <div class="tgme_widget_message_wrap js-widget_message_wrap">
      <div class="tgme_widget_message" data-post="canalgate/101">
        <div class="tgme_widget_message_text js-message_text" dir="auto">
          Filme novo<br>Disponível hoje &amp; em destaque
        </div>
        <div class="tgme_widget_message_footer">
          <a class="tgme_widget_message_date"><time datetime="2026-07-27T10:00:00+00:00"></time></a>
        </div>
      </div>
    </div>
  `;
  const posts = parseTelegramPreview(html);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].sourcePostId, 'canalgate/101');
  assert.match(posts[0].content, /Filme novo/);
  assert.match(posts[0].content, /Disponível hoje & em destaque/);
  assert.equal(posts[0].url, 'https://t.me/canalgate/101');
});

test('formata o resumo diário para o WhatsApp', () => {
  const message = formatTelegramDigest([
    {
      content: 'Nova temporada adicionada ao catálogo',
      url: 'https://t.me/canalgate/102'
    }
  ]);
  assert.match(message, /Novidades do Gate One Pro/);
  assert.match(message, /Nova temporada/);
  assert.match(message, /atualizado diariamente/);
});
