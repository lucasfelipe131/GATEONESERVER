import { createHmac } from 'node:crypto';
import { safeEqual } from '../security.js';

function graphUrl(config) {
  if (!config.WHATSAPP_PHONE_NUMBER_ID) throw new Error('WHATSAPP_PHONE_NUMBER_ID não configurado.');
  return `https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

export function verifyMetaSignature(config, rawBody, signature) {
  if (!config.META_APP_SECRET) return config.WHATSAPP_MODE !== 'live';
  const expected = `sha256=${createHmac('sha256', config.META_APP_SECRET).update(rawBody).digest('hex')}`;
  return safeEqual(expected, signature);
}

async function send(config, payload) {
  if (config.WHATSAPP_MODE === 'simulation') {
    return { messages: [{ id: `SIM-WA-${Date.now()}` }], simulated: true };
  }
  if (!config.WHATSAPP_ACCESS_TOKEN) throw new Error('WHATSAPP_ACCESS_TOKEN não configurado.');
  const response = await fetch(graphUrl(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload })
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`WhatsApp recusou a mensagem (${response.status}): ${body.error?.message || 'erro'}`);
  }
  return { ...body, simulated: false };
}

export function sendText(config, to, body) {
  return send(config, {
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body }
  });
}

export function sendPlanMenu(config, to) {
  return send(config, {
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text:
          'Bem-vindo ao Gate One Pro! Escolha um plano para receber as instruções de ativação:'
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'plan_monthly', title: 'Mensal — R$ 30' } },
          { type: 'reply', reply: { id: 'plan_quarterly', title: 'Trimestral — R$ 80' } }
        ]
      }
    }
  });
}

function templateForStage(config, stage) {
  return {
    'd-3': config.WHATSAPP_TEMPLATE_D3,
    d0: config.WHATSAPP_TEMPLATE_D0,
    'd+2': config.WHATSAPP_TEMPLATE_D2,
    'd+5': config.WHATSAPP_TEMPLATE_D5,
    manual: config.WHATSAPP_TEMPLATE_D0,
    new_sale: config.WHATSAPP_TEMPLATE_D0
  }[stage];
}

export function sendChargeTemplate(config, charge) {
  return send(config, {
    recipient_type: 'individual',
    to: charge.whatsapp_e164,
    type: 'template',
    template: {
      name: templateForStage(config, charge.stage),
      language: { code: 'pt_BR' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: charge.customer_name.split(/\s+/)[0] },
            { type: 'text', text: charge.plan_name },
            { type: 'text', text: charge.due_on_br },
            { type: 'text', text: charge.amount_br },
            { type: 'text', text: charge.pix_copy_paste || 'Pix em preparação' }
          ]
        }
      ]
    }
  });
}

export function sendPaymentConfirmationTemplate(config, charge) {
  return send(config, {
    recipient_type: 'individual',
    to: charge.whatsapp_e164,
    type: 'template',
    template: {
      name: config.WHATSAPP_TEMPLATE_PAYMENT_CONFIRMED,
      language: { code: 'pt_BR' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: charge.customer_name.split(/\s+/)[0] },
            { type: 'text', text: charge.plan_name }
          ]
        }
      ]
    }
  });
}

export function sendRenewedTemplate(config, renewal, renewedUntil) {
  return send(config, {
    recipient_type: 'individual',
    to: renewal.whatsapp_e164,
    type: 'template',
    template: {
      name: config.WHATSAPP_TEMPLATE_RENEWED,
      language: { code: 'pt_BR' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: renewal.customer_name.split(/\s+/)[0] },
            { type: 'text', text: renewal.plan_name },
            { type: 'text', text: renewedUntil }
          ]
        }
      ]
    }
  });
}

export function sendAccessCreatedTemplate(config, renewal, access, expiresOn) {
  return send(config, {
    recipient_type: 'individual',
    to: renewal.whatsapp_e164,
    type: 'template',
    template: {
      name: config.WHATSAPP_TEMPLATE_ACCESS_CREATED,
      language: { code: 'pt_BR' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: renewal.customer_name.split(/\s+/)[0] },
            { type: 'text', text: access.username },
            { type: 'text', text: access.password },
            { type: 'text', text: expiresOn }
          ]
        }
      ]
    }
  });
}

export function parseWhatsAppWebhook(payload) {
  const result = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const name = value.contacts?.[0]?.profile?.name || 'Cliente';
      for (const message of value.messages || []) {
        const interactive = message.interactive;
        result.push({
          id: message.id,
          from: message.from,
          name,
          timestamp: message.timestamp,
          type: message.type,
          text:
            message.text?.body ||
            interactive?.button_reply?.id ||
            interactive?.list_reply?.id ||
            ''
        });
      }
    }
  }
  return result;
}
