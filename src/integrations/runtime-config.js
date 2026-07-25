import { decryptSecret, encryptSecret } from '../security.js';

const ENV_FIELDS = {
  mercadopago: [
    'MERCADOPAGO_ACCESS_TOKEN',
    'MERCADOPAGO_WEBHOOK_SECRET',
    'MERCADOPAGO_NOTIFICATION_URL',
    'MERCADOPAGO_PAYER_EMAIL'
  ],
  whatsapp: [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_VERIFY_TOKEN',
    'META_APP_SECRET',
    'WHATSAPP_GRAPH_VERSION'
  ],
  bitpanel: [
    'BITPANEL_USERNAME',
    'BITPANEL_PASSWORD',
    'BITPANEL_BASE_URL',
    'BITPANEL_LOGIN_URL',
    'BITPANEL_PLAN_LABEL',
    'BITPANEL_TV_PACKAGE',
    'BITPANEL_DEFAULT_CONNECTIONS'
  ],
  openai: [
    'OPENAI_API_KEY',
    'OPENAI_MODEL'
  ]
};

export const integrationProviders = Object.keys(ENV_FIELDS);

function configuredBaseValues(baseConfig, provider) {
  return Object.fromEntries(
    ENV_FIELDS[provider]
      .filter((field) => baseConfig[field] !== undefined && baseConfig[field] !== '')
      .map((field) => [field, String(baseConfig[field]).trim()])
  );
}

export async function saveIntegrationCredentials(db, baseConfig, provider, values, userId) {
  const allowed = ENV_FIELDS[provider];
  if (!allowed) throw new Error('Integração desconhecida.');

  // Preserve credentials that may still live only in Railway environment variables.
  // Previously, the first panel save could replace them with an incomplete DB record.
  const existing = await readStored(db, baseConfig, provider);
  const clean = {
    ...configuredBaseValues(baseConfig, provider),
    ...existing
  };
  for (const field of allowed) {
    if (values[field] === undefined || values[field] === '') continue;
    clean[field] = String(values[field]).trim();
  }

  if (provider === 'bitpanel' && !clean.BITPANEL_PASSWORD) {
    const error = new Error('Digite a senha do BitPanel antes de salvar.');
    error.statusCode = 400;
    throw error;
  }

  const encrypted = encryptSecret(JSON.stringify(clean), baseConfig.COOKIE_SECRET);
  await db.query(
    `INSERT INTO integration_credentials (provider, encrypted_value, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider) DO UPDATE
       SET encrypted_value = EXCLUDED.encrypted_value,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [provider, encrypted, userId]
  );

  // Verify the encrypted value can be read back before reporting success.
  const saved = await readStored(db, baseConfig, provider);
  if (provider === 'bitpanel' && !saved.BITPANEL_PASSWORD) {
    throw new Error('A senha do BitPanel não pôde ser confirmada no banco de dados.');
  }
}

async function readStored(db, baseConfig, provider) {
  const result = await db.query(
    'SELECT encrypted_value FROM integration_credentials WHERE provider = $1',
    [provider]
  );
  if (!result.rows[0]) return {};
  return JSON.parse(decryptSecret(result.rows[0].encrypted_value, baseConfig.COOKIE_SECRET));
}

export async function getRuntimeConfig(db, baseConfig) {
  const stored = await Promise.all(
    integrationProviders.map((provider) => readStored(db, baseConfig, provider))
  );
  return Object.assign({}, baseConfig, ...stored);
}

export async function credentialStatus(db, baseConfig) {
  const runtime = await getRuntimeConfig(db, baseConfig);
  return {
    runtime,
    configured: {
      mercadopago: Boolean(
        runtime.MERCADOPAGO_ACCESS_TOKEN && runtime.MERCADOPAGO_WEBHOOK_SECRET
      ),
      whatsapp: Boolean(
        runtime.WHATSAPP_ACCESS_TOKEN &&
          runtime.WHATSAPP_PHONE_NUMBER_ID &&
          runtime.WHATSAPP_VERIFY_TOKEN &&
          runtime.META_APP_SECRET
      ),
      bitpanel: Boolean(runtime.BITPANEL_USERNAME && runtime.BITPANEL_PASSWORD),
      openai: Boolean(runtime.OPENAI_API_KEY && runtime.OPENAI_MODEL)
    }
  };
}
