import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import rawBody from 'fastify-raw-body';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createDb, getSetting, setSetting } from './db.js';
import { initializeDatabase } from './init.js';
import { authenticate, clearSessionCookie, login, logout, setSessionCookie } from './auth.js';
import { audit } from './audit.js';
import { createQueues, createRedis } from './queue.js';
import { maskPhone, normalizePhone, randomToken, sanitizeForLog, sha256 } from './security.js';
import { scanBilling, markPaymentApproved } from './services/billing.js';
import { buildIdempotencyKey, renderChargeMessage } from './domain/billing.js';
import {
  createCheckoutPreference,
  getMercadoPagoPayment,
  getMercadoPagoReadiness,
  verifyMercadoPagoWebhook
} from './integrations/mercadopago.js';
import {
  parseWhatsAppWebhook,
  verifyMetaSignature
} from './integrations/whatsapp.js';
import { handleInboundMessage } from './services/sales.js';
import {
  credentialStatus,
  getRuntimeConfig,
  saveIntegrationCredentials
} from './integrations/runtime-config.js';
import { fetchBitPanelCustomers, testBitPanelConnection } from './integrations/bitpanel.js';
import { testOpenAIConnection } from './integrations/openai.js';
import { parseCustomerSpreadsheet } from './importers/spreadsheet.js';
import { answerAdminQuestion } from './services/ai-support.js';
import { registerChatbotRoutes } from './routes-chatbot.js';
