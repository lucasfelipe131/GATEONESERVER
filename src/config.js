import { z } from 'zod';

const bool = (fallback) =>
  z
    .string()
    .optional()
    .transform((value) => (value == null ? fallback : value.toLowerCase() === 'true'));

const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional()
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: optionalUrl,
  PUBLIC_WHATSAPP_NUMBER: z.string().optional(),
  TIMEZONE: z.string().default('America/Sao_Paulo'),
  COOKIE_SECRET: z.string().min(32).default('development-only-change-this-secret-now'),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool(false),
  REDIS_URL: z.string().min(1).optional(),
  ADMIN_NAME: z.string().default('Administrador'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(6).optional(),
  GLOBAL_PAUSE: bool(true),
  SEED_DEMO: bool(false),
  SALES_MODE: z.enum(['simulation', 'approval', 'automatic']).default('approval'),
  PAYMENT_MODE: z.enum(['simulation', 'live']).default('simulation'),
  WHATSAPP_MODE: z.enum(['simulation', 'live']).default('simulation'),
  BITPANEL_MODE: z.enum(['disabled', 'simulation', 'live']).default('disabled'),
  RENEWAL_REQUIRES_APPROVAL: bool(true),
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().optional(),
  MERCADOPAGO_NOTIFICATION_URL: optionalUrl,
  MERCADOPAGO_PAYER_EMAIL: z.email().default('pagamentos@gateonepro.com.br'),
  PIX_EXPIRATION_MINUTES: z.coerce.number().int().min(10).max(1440).default(60),
  WHATSAPP_GRAPH_VERSION: z.string().default('v23.0'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  WHATSAPP_TEMPLATE_D3: z.string().default('gate_one_vencimento_d3'),
  WHATSAPP_TEMPLATE_D0: z.string().default('gate_one_vencimento_hoje'),
  WHATSAPP_TEMPLATE_D2: z.string().default('gate_one_atraso_d2'),
  WHATSAPP_TEMPLATE_D5: z.string().default('gate_one_ultimo_aviso_d5'),
  WHATSAPP_TEMPLATE_PAYMENT_CONFIRMED: z.string().default('gate_one_pagamento_confirmado'),
  WHATSAPP_TEMPLATE_RENEWED: z.string().default('gate_one_renovacao_concluida'),
  WHATSAPP_TEMPLATE_ACCESS_CREATED: z.string().default('gate_one_acesso_criado'),
  // Shared secret used only by the separate Gate One WhatsApp QR service.
  // This is intentionally independent from Meta Cloud API credentials.
  GATE_ONE_BOT_SECRET: z.string().min(24).optional(),
  // Delivery configuration for the separately deployed WhatsApp QR service.
  // The service owns the WhatsApp session; Gate One only sends it safe notices.
  GATE_ONE_WHATSAPP_QR_URL: optionalUrl,
  GATE_ONE_WHATSAPP_NOTIFY_SECRET: z.string().min(24).optional(),
  GATE_ONE_OWNER_WHATSAPP: z.string().optional(),
  TELEGRAM_CONTENT_URL: z.string().url().default('https://bit.ly/telebit2'),
  TELEGRAM_SYNC_ENABLED: bool(true),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5.6'),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  AI_ADMIN_ENABLED: bool(false),
  AI_WHATSAPP_ENABLED: bool(false),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(2000).default(700),
  BITPANEL_BASE_URL: z.string().url().default('https://bitpanel.vip'),
  BITPANEL_LOGIN_URL: z.string().url().default('https://bitpanel.vip/login'),
  BITPANEL_USERNAME: z.string().optional(),
  BITPANEL_PASSWORD: z.string().optional(),
  BITPANEL_PLAN_LABEL: z.string().default('30, R$ 30,00'),
  BITPANEL_TV_PACKAGE: z
    .string()
    .default('Full HD + H265 + HD + SD + VOD + Adulto'),
  BITPANEL_DEFAULT_CONNECTIONS: z.coerce.number().int().min(1).max(10).default(1),
  BITPANEL_HEADLESS: bool(true),
  ARTIFACTS_DIR: z.string().default('/app/artifacts')
});

export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração inválida: ${message}`);
  }
  return parsed.data;
}
