import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decryptSecret, encryptSecret, normalizePhone, randomToken, sha256 } from '../security.js';
import { getSetting } from '../db.js';
import { cleanCustomerName } from './customer-memory.js';
import { PgConversationAgentRepository } from './conversation-operations.js';

export const PRIVACY_NOTICE_VERSION = '2026-10-12.1';
export const PORTAL_LINK_MINUTES = 15;
export const PORTAL_SESSION_HOURS = 24;
const failure = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const tokenValid = value => /^[A-Za-z0-9_-]{32,100}$/.test(String(value || ''));

export function paymentMethods(value) {
  const allowed = new Set(['Pix', 'Cartão de crédito', 'Boleto']);
  return [...new Set((Array.isArray(value) ? value : []).filter(method => allowed.has(method)))];
}

export function portalUrl(baseUrl, token) {
  // Fragments are not transmitted in HTTP requests or proxy access logs.
  return `${String(baseUrl || '').replace(/\/$/, '')}/cliente#${token}`;
}

export class CustomerPortal {
  constructor({ db, config, billing, getPaymentOptions }) {
    Object.assign(this, { db, config, billing, getPaymentOptions });
  }

  async privacyNotice() {
    const controller = await getSetting(this.db, 'privacy_controller_name', null);
    const contact = await getSetting(this.db, 'privacy_contact', null);
    return {
      version: PRIVACY_NOTICE_VERSION, controller, contact, ready: Boolean(controller && contact),
      whatsapp_url:this.config.PUBLIC_WHATSAPP_NUMBER?`https://wa.me/${this.config.PUBLIC_WHATSAPP_NUMBER}`:null,
      purposes: ['Cadastro e identificação da conta', 'Atendimento e gestão da assinatura', 'Cobranças solicitadas e confirmação de pagamentos'],
      data: ['Nome', 'WhatsApp verificado', 'E-mail de contato, opcional', 'Login do serviço e histórico da assinatura e dos pagamentos'],
      providers: ['Mercado Pago, para processar pagamentos', 'WhatsApp/Meta, para comunicação', 'Railway, para hospedagem e armazenamento'],
      legalBasis: 'Os dados necessários ao atendimento e à assinatura são tratados para executar o contrato ou procedimentos solicitados pelo cliente. Avisos opcionais pelo WhatsApp dependem de autorização separada.',
      retention: 'Mantemos os dados necessários enquanto houver atendimento ou assinatura. Após o encerramento, pedidos de eliminação são avaliados; documentos e registros podem ser conservados quando houver obrigação legal ou necessidade de exercer direitos.',
      rights: 'Você pode acessar e corrigir seus dados, solicitar cópia ou eliminação e retirar a autorização para avisos. Pedidos são gratuitos e podem ser feitos nesta área ou pelo contato indicado.',
      noCpf: 'O cadastro Gate One Pro não solicita CPF nem dados de cartão. O Mercado Pago poderá solicitar informações próprias no checkout, conforme suas regras.'
    };
  }

  async issueLink({ customerId, requestKey }) {
    return this.db.transaction(async client => {
      const customer = (await client.query('SELECT id,whatsapp_e164 FROM customers WHERE id=$1 FOR UPDATE', [customerId])).rows[0];
      if (!customer?.whatsapp_e164) throw failure('PORTAL_CUSTOMER_NOT_FOUND', 404);
      const previous = (await client.query('SELECT * FROM customer_portal_links WHERE customer_id=$1 AND request_key=$2', [customer.id, requestKey])).rows[0];
      if (previous) {
        if (previous.used_at || new Date(previous.expires_at) <= new Date() || previous.whatsapp_e164 !== customer.whatsapp_e164) throw failure('PORTAL_LINK_EXPIRED', 410);
        return { portalUrl: portalUrl(this.config.PUBLIC_BASE_URL, decryptSecret(previous.token_encrypted, this.config.COOKIE_SECRET)), expiresAt: previous.expires_at };
      }
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + PORTAL_LINK_MINUTES * 60_000).toISOString();
      await client.query(`INSERT INTO customer_portal_links(token_hash,customer_id,whatsapp_e164,request_key,token_encrypted,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [sha256(token), customer.id, customer.whatsapp_e164, requestKey, encryptSecret(token, this.config.COOKIE_SECRET), expiresAt]);
      return { portalUrl: portalUrl(this.config.PUBLIC_BASE_URL, token), expiresAt };
    });
  }

  async issueWhatsAppLink({ phone, messageId }) {
    const normalized = normalizePhone(phone);
    const customer = (await this.db.query('SELECT id FROM customers WHERE whatsapp_e164=$1', [normalized])).rows[0];
    if (!customer) throw failure('PORTAL_CUSTOMER_NOT_FOUND', 404);
    const hold = await new PgConversationAgentRepository(this.db).activeHandoff(`whatsapp:${normalized}`, customer.id);
    if (hold && !hold.automation_resumed) throw failure('PORTAL_HUMAN_HOLD', 409);
    return this.issueLink({ customerId: customer.id, requestKey: `whatsapp:${sha256(messageId)}` });
  }

  async exchangeLink(token) {
    if (!tokenValid(token)) throw failure('PORTAL_LINK_INVALID', 401);
    return this.db.transaction(async client => {
      const hash = sha256(token);
      const link = (await client.query(`SELECT l.* FROM customer_portal_links l JOIN customers c ON c.id=l.customer_id
        AND c.whatsapp_e164=l.whatsapp_e164 WHERE l.token_hash=$1 AND l.used_at IS NULL AND l.expires_at>now() FOR UPDATE OF l`, [hash])).rows[0];
      let customerId = link?.customer_id, phone = link?.whatsapp_e164;
      if (link) await client.query('UPDATE customer_portal_links SET used_at=now(),token_encrypted=$2 WHERE token_hash=$1', [hash, '[consumed]']);
      else {
        const legacy = (await client.query(`SELECT id,whatsapp_e164 FROM customers WHERE portal_token_hash=$1
          AND portal_token_expires_at>now() AND whatsapp_e164 IS NOT NULL FOR UPDATE`, [hash])).rows[0];
        if (!legacy) throw failure('PORTAL_LINK_INVALID', 401);
        customerId = legacy.id; phone = legacy.whatsapp_e164;
        await client.query('UPDATE customers SET portal_token_hash=NULL,portal_token_expires_at=NULL WHERE id=$1', [customerId]);
      }
      const sessionToken = randomToken(32);
      const expiresAt = new Date(Date.now() + PORTAL_SESSION_HOURS * 3_600_000).toISOString();
      await client.query('DELETE FROM customer_portal_sessions WHERE customer_id=$1 AND expires_at<=now()', [customerId]);
      await client.query(`INSERT INTO customer_portal_sessions(token_hash,customer_id,whatsapp_e164,expires_at) VALUES($1,$2,$3,$4)`, [sha256(sessionToken), customerId, phone, expiresAt]);
      return { sessionToken, expiresAt };
    });
  }

  async authenticate(sessionToken) {
    if (!tokenValid(sessionToken)) return null;
    return (await this.db.query(`SELECT s.customer_id,s.token_hash FROM customer_portal_sessions s JOIN customers c ON c.id=s.customer_id
      AND c.whatsapp_e164=s.whatsapp_e164 WHERE s.token_hash=$1 AND s.expires_at>now()`, [sha256(sessionToken)])).rows[0] || null;
  }

  async account(customerId) {
    const customer = (await this.db.query(`SELECT c.name,c.email,c.whatsapp_e164,c.bitpanel_reference AS login,c.operational_stage,
      c.consent_contact,c.opt_out_at,c.status,s.expires_on::text,p.code AS plan_code,p.name AS plan_name,p.price_cents,
      COALESCE((SELECT sum(points) FROM loyalty_ledger WHERE customer_id=c.id),0)::int AS points
      FROM customers c LEFT JOIN LATERAL(SELECT * FROM subscriptions WHERE customer_id=c.id ORDER BY created_at DESC LIMIT 1) s ON true
      LEFT JOIN plans p ON p.id=s.plan_id WHERE c.id=$1`, [customerId])).rows[0];
    if (!customer) throw failure('PORTAL_SESSION_INVALID', 401);
    const plans = (await this.db.query('SELECT code,name,duration_months,price_cents,description FROM plans WHERE active=true ORDER BY sort_order')).rows;
    const payments = (await this.db.query(`SELECT ch.id,ch.amount_cents,ch.created_at,ch.paid_at,ch.checkout_url,
      COALESCE(bp.status,CASE WHEN ch.status='paid' THEN 'CONFIRMED' WHEN ch.status='cancelled' THEN 'CANCELLED' ELSE 'PENDING' END) AS status,
      COALESCE(bp.provider='fake',false) AS simulated,p.name AS plan_name
      FROM charges ch JOIN subscriptions s ON s.id=ch.subscription_id LEFT JOIN plans p ON p.id=COALESCE(ch.plan_id,s.plan_id)
      LEFT JOIN LATERAL(SELECT status,provider FROM payments WHERE charge_id=ch.id ORDER BY created_at DESC LIMIT 1) bp ON true
      WHERE s.customer_id=$1 ORDER BY ch.created_at DESC LIMIT 50`, [customerId])).rows;
    for (const payment of payments) {
      if (!['PENDING','CREATED'].includes(payment.status) || payment.simulated || !this.safeCheckout(payment.checkout_url)) payment.checkout_url = null;
    }
    const notice = await this.privacyNotice();
    const acknowledged = (await this.db.query(`SELECT created_at FROM customer_privacy_events WHERE customer_id=$1
      AND event_type='NOTICE_ACKNOWLEDGED' AND notice_version=$2 ORDER BY created_at DESC LIMIT 1`, [customerId, notice.version])).rows[0]?.created_at || null;
    const requests = (await this.db.query(`SELECT pr.id,pr.request_type,pr.created_at,
      CASE WHEN h.status IN ('RESOLVED','CANCELLED') THEN 'REVIEWED' ELSE 'REQUESTED' END AS status
      FROM customer_privacy_requests pr LEFT JOIN conversation_handoffs h ON h.handoff_id=pr.handoff_id
      WHERE pr.customer_id=$1 ORDER BY pr.created_at DESC LIMIT 20`, [customerId])).rows;
    let methods = [];
    try { methods = paymentMethods((await this.getPaymentOptions()).methods); } catch { /* Checkout remains authoritative when the catalog is unavailable. */ }
    return { ...customer, consent_contact: Boolean(customer.consent_contact && !customer.opt_out_at), plans, payments, payment_methods: methods,
      privacy: { ...notice, acknowledgedAt: acknowledged, requests }, whatsapp_url: this.config.PUBLIC_WHATSAPP_NUMBER ? `https://wa.me/${this.config.PUBLIC_WHATSAPP_NUMBER}` : null };
  }

  safeCheckout(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password &&
      ['www.mercadopago.com.br','mercadopago.com.br','www.mercadopago.com','mercadopago.com'].includes(url.hostname); } catch { return false; }
  }

  async saveProfile(customerId, input) {
    const data = z.object({ name:z.string().min(2).max(120), email:z.union([z.email().max(200),z.literal('')]).optional(),
      claimedLogin:z.string().max(80).optional(), noticeAcknowledged:z.literal(true), noticeVersion:z.literal(PRIVACY_NOTICE_VERSION),
      consentContact:z.boolean() }).strict().parse(input);
    const name = cleanCustomerName(data.name);
    if (!name) throw failure('PORTAL_NAME_INVALID');
    const notice = await this.privacyNotice();
    if (!notice.ready) throw failure('PORTAL_PRIVACY_NOT_CONFIGURED', 503);
    return this.db.transaction(async client => {
      const customer = (await client.query('SELECT id,whatsapp_e164,bitpanel_reference,consent_contact,opt_out_at FROM customers WHERE id=$1 FOR UPDATE', [customerId])).rows[0];
      if (!customer) throw failure('PORTAL_SESSION_INVALID',401);
      await client.query(`UPDATE customers SET name=$2,email=$3,name_confirmed_at=now(),consent_contact=$4,
        opt_out_at=CASE WHEN $4 THEN NULL ELSE opt_out_at END,updated_at=now() WHERE id=$1`, [customerId,name,data.email || null,data.consentContact]);
      await client.query(`INSERT INTO customer_privacy_events(customer_id,event_type,notice_version,channel) VALUES($1,'NOTICE_ACKNOWLEDGED',$2,'PORTAL')`, [customerId,notice.version]);
      if (data.consentContact !== Boolean(customer.consent_contact && !customer.opt_out_at)) await client.query(`INSERT INTO customer_privacy_events(customer_id,event_type,notice_version,channel) VALUES($1,$2,$3,'PORTAL')`, [customerId,data.consentContact?'CONTACT_GRANTED':'CONTACT_WITHDRAWN',notice.version]);
      const login = String(data.claimedLogin || '').trim().toLowerCase();
      let identityReview = false;
      if (login && login !== String(customer.bitpanel_reference || '').trim().toLowerCase()) {
        if (!/^[a-z0-9._@-]{3,80}$/.test(login)) throw failure('PORTAL_LOGIN_INVALID');
        await client.query(`INSERT INTO customer_identity_links(whatsapp_e164,source_customer_id,claimed_login,status,reason,confidence)
          VALUES($1,$2,$3,'pending','portal_identity_claim',0)
          ON CONFLICT(whatsapp_e164,lower(claimed_login)) WHERE status='pending' DO UPDATE SET updated_at=now()`, [customer.whatsapp_e164,customerId,login]);
        await new PgConversationAgentRepository({query:(...args)=>client.query(...args),transaction:fn=>fn(client)}).requestHandoff({
          conversation_id:`whatsapp:${customer.whatsapp_e164}`,customer_id:customerId,correlation_id:randomUUID(),reason:'PORTAL_IDENTITY_REVIEW',
          summary:'Cliente informou um login no portal. Conferir o vínculo antes de liberar outra conta.',requested_by:{type:'SERVICE',id:'customer-portal'},idempotency_key:`portal-identity:${customerId}:${sha256(login)}` });
        identityReview = true;
      }
      return { ok:true, identityReview };
    });
  }

  async requestPayment(customerId, input) {
    const {planCode,requestId}=z.object({planCode:z.enum(['monthly','quarterly','semiannual','annual']),requestId:z.uuid()}).strict().parse(input);
    if (!this.billing) throw failure('LIVE_BILLING_PAUSED_OR_UNAVAILABLE',503);
    const payment = await this.billing.requestPayment({customer_id:customerId,plan_code:planCode,idempotency_key:`portal:${customerId}:${requestId}`,correlation_id:randomUUID()});
    if (payment.simulated || !this.safeCheckout(payment.checkout_url)) throw failure('PORTAL_CHECKOUT_UNAVAILABLE',409);
    return {checkoutUrl:payment.checkout_url,planName:payment.plan_name,amountCents:payment.amount_cents,status:payment.status,existing:payment.existing};
  }

  async withdrawContact(customerId) {
    return this.db.transaction(async client => {
      // Optional reminders are separate from requested transactional replies.
      // Preserve the global WhatsApp opt-out recorded by the chat.
      await client.query('UPDATE customers SET consent_contact=false,updated_at=now() WHERE id=$1',[customerId]);
      await client.query(`INSERT INTO customer_privacy_events(customer_id,event_type,notice_version,channel) VALUES($1,'CONTACT_WITHDRAWN',$2,'PORTAL')`,[customerId,PRIVACY_NOTICE_VERSION]);
      return {ok:true};
    });
  }

  async requestPrivacy(customerId,input) {
    const {type,requestId} = z.object({type:z.enum(['ACCESS','CORRECTION','ERASURE']),requestId:z.uuid()}).strict().parse(input);
    return this.db.transaction(async client => {
      const customer=(await client.query('SELECT whatsapp_e164 FROM customers WHERE id=$1 FOR UPDATE',[customerId])).rows[0];
      const previous=(await client.query('SELECT id FROM customer_privacy_requests WHERE customer_id=$1 AND request_key=$2',[customerId,requestId])).rows[0];
      if(previous) return {ok:true,requestId:previous.id,duplicate:true};
      const labels={ACCESS:'cópia completa dos dados',CORRECTION:'correção de dados',ERASURE:'eliminação de dados'};
      const handoff=await new PgConversationAgentRepository({query:(...args)=>client.query(...args),transaction:fn=>fn(client)}).requestHandoff({
        conversation_id:`whatsapp:${customer.whatsapp_e164}`,customer_id:customerId,correlation_id:randomUUID(),reason:'PRIVACY_REQUEST',
        summary:`Pedido de privacidade pelo portal: ${labels[type]}. Conferir o pedido e eventuais obrigações de conservação antes de concluir.`,
        requested_by:{type:'SERVICE',id:'customer-portal'},idempotency_key:`portal-privacy:${customerId}:${requestId}`});
      if(handoff.duplicate) await client.query(`UPDATE conversation_handoffs SET summary=COALESCE(summary,'') || $3,updated_at=now()
        WHERE handoff_id=$1 AND customer_id=$2`,[handoff.handoff_id,customerId,`\nPedido de privacidade registrado: ${labels[type]}. Protocolo ${requestId}.`]);
      const row=(await client.query('INSERT INTO customer_privacy_requests(customer_id,request_key,request_type,handoff_id) VALUES($1,$2,$3,$4) RETURNING id',[customerId,requestId,type,handoff.handoff_id])).rows[0];
      return {ok:true,requestId:row.id};
    });
  }
}
