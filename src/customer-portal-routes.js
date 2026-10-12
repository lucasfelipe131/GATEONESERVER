import { z } from 'zod';
import { hmacSha256, safeEqual } from './security.js';
import { isTrustedMutationOrigin } from './authorization.js';
import { CustomerPortal } from './services/customer-portal.js';

export const PORTAL_COOKIE = 'gate_customer_session';
const errors = {
  PORTAL_LINK_INVALID: 'Este link expirou ou já foi utilizado. Peça um novo link pelo WhatsApp enviando PORTAL.',
  PORTAL_LINK_EXPIRED: 'Peça um novo link pelo WhatsApp enviando PORTAL.',
  PORTAL_CUSTOMER_NOT_FOUND: 'Inicie a conversa pelo seu WhatsApp para acessar o cadastro.',
  PORTAL_SESSION_INVALID: 'Seu acesso expirou. Peça um novo link pelo WhatsApp enviando PORTAL.',
  PORTAL_HUMAN_HOLD: 'O atendimento humano está em andamento. Envie MENU antes de voltar às opções automáticas.',
  PORTAL_PRIVACY_NOT_CONFIGURED: 'O aviso de privacidade está sendo configurado. O cadastro será liberado após essa etapa.',
  PORTAL_NAME_INVALID: 'Confira seu nome antes de salvar.', PORTAL_LOGIN_INVALID: 'Informe apenas o login, sem senha.',
  PORTAL_CHECKOUT_UNAVAILABLE: 'A cobrança precisa ser conferida pela equipe antes de gerar um link real.',
  PENDING_PAYMENT_PLAN_CONFLICT: 'Já existe uma cobrança pendente para outro plano. Use o link existente ou peça ajuda pelo WhatsApp.',
  CHECKOUT_IN_PROGRESS: 'Sua cobrança está sendo preparada. Aguarde e consulte esta página novamente.',
  SUBSCRIPTION_NOT_FOUND: 'Seu cadastro está salvo. A equipe precisa conferir e preparar sua assinatura antes da primeira cobrança.',
  LIVE_BILLING_PAUSED_OR_UNAVAILABLE: 'A cobrança está indisponível agora. Peça ajuda pelo WhatsApp.',
  BILLING_CYCLE_ALREADY_CLOSED: 'Este ciclo já foi concluído. Consulte os pagamentos ou fale com a equipe.',
  SUBSCRIPTION_NOT_ELIGIBLE: 'A equipe precisa conferir sua assinatura antes da cobrança.'
};

export function registerCustomerPortal(app, {db,config,billingAutomation,getPaymentOptions,requireBotSecret}) {
  const portal=new CustomerPortal({db,config,billing:billingAutomation,getPaymentOptions});
  app.decorateRequest('portalSession',null);
  const privateHeaders=async(_request,reply)=>{
    reply.header('Cache-Control','no-store, private').header('Referrer-Policy','no-referrer').header('X-Robots-Tag','noindex, nofollow');
  };
  const safe=handler=>async(request,reply)=>{
    try { return await handler(request,reply); }
    catch(error) {
      if(error instanceof z.ZodError) return reply.code(400).send({error:'Confira os dados informados. O cadastro não solicita CPF, senha ou dados de cartão.'});
      if(errors[error.code]) return reply.code(error.statusCode || 409).send({error:errors[error.code]});
      throw error;
    }
  };
  const requireSession=async(request,reply)=>{
    const session=await portal.authenticate(request.cookies?.[PORTAL_COOKIE]);
    if(!session) return reply.code(401).send({error:errors.PORTAL_SESSION_INVALID});
    request.portalSession=session;
  };
  const csrf=request=>hmacSha256(config.COOKIE_SECRET,`portal-csrf:${request.cookies[PORTAL_COOKIE]}`);
  const requireMutation=async(request,reply)=>{
    if(!isTrustedMutationOrigin(request,config.PUBLIC_BASE_URL) || !safeEqual(request.headers['x-portal-csrf'],csrf(request)))
      return reply.code(403).send({error:'Reabra sua área do cliente para continuar.'});
  };
  const readOptions={onRequest:privateHeaders,preHandler:requireSession};
  const writeOptions={onRequest:privateHeaders,preHandler:[requireSession,requireMutation],config:{rateLimit:{max:20,timeWindow:'1 hour'}}};
  app.get('/api/portal/privacy',{onRequest:privateHeaders},()=>portal.privacyNotice());
  app.post('/api/portal/session',{onRequest:privateHeaders,config:{rateLimit:{max:20,timeWindow:'15 minutes'}}},safe(async(request,reply)=>{
    if(!isTrustedMutationOrigin(request,config.PUBLIC_BASE_URL)) return reply.code(403).send({error:'Acesso indisponível.'});
    const {token}=z.object({token:z.string().min(32).max(100)}).strict().parse(request.body);
    const session=await portal.exchangeLink(token);
    reply.setCookie(PORTAL_COOKIE,session.sessionToken,{path:'/api/portal',httpOnly:true,sameSite:'lax',secure:config.NODE_ENV==='production',maxAge:86400});
    return {ok:true,expiresAt:session.expiresAt};
  }));
  app.get('/api/portal/me',readOptions,safe(async request=>({...await portal.account(request.portalSession.customer_id),csrf_token:csrf(request)})));
  app.patch('/api/portal/me/profile',writeOptions,safe(request=>portal.saveProfile(request.portalSession.customer_id,request.body)));
  app.post('/api/portal/me/payments',{...writeOptions,config:{rateLimit:{max:6,timeWindow:'1 hour'}}},safe(request=>portal.requestPayment(request.portalSession.customer_id,request.body)));
  app.post('/api/portal/me/privacy/withdraw',writeOptions,safe(request=>portal.withdrawContact(request.portalSession.customer_id)));
  app.post('/api/portal/me/privacy/requests',writeOptions,safe(request=>portal.requestPrivacy(request.portalSession.customer_id,request.body)));
  app.get('/api/portal/me/export',readOptions,safe(async(request,reply)=>{
    const account=await portal.account(request.portalSession.customer_id);
    reply.header('Content-Disposition','attachment; filename="meus-dados-gate-one.json"');
    return {...account,exported_at:new Date().toISOString(),scope:'Resumo do cadastro, da assinatura, dos últimos 50 pagamentos e dos pedidos de privacidade. Para cópia completa, solicite pelo botão de privacidade.'};
  }));
  app.post('/api/portal/logout',writeOptions,safe(async(request,reply)=>{
    await db.query('DELETE FROM customer_portal_sessions WHERE token_hash=$1',[request.portalSession.token_hash]);
    reply.clearCookie(PORTAL_COOKIE,{path:'/api/portal'}); return {ok:true};
  }));
  app.post('/api/integrations/whatsapp/portal',{onRequest:privateHeaders},safe(async(request,reply)=>{
    if(!requireBotSecret(request,reply)) return;
    const {whatsapp,messageId}=z.object({whatsapp:z.string().min(10).max(30),messageId:z.string().min(1).max(250)}).strict().parse(request.body);
    return portal.issueWhatsAppLink({phone:whatsapp,messageId});
  }));
  // Old token APIs are retired; the old page exchanges its link for a scoped session.
  app.get('/api/portal/:token',{onRequest:privateHeaders},(_request,reply)=>reply.code(410).send({error:errors.PORTAL_LINK_INVALID}));
  app.post('/api/portal/:token/renewals',{onRequest:privateHeaders},(_request,reply)=>reply.code(410).send({error:errors.PORTAL_LINK_INVALID}));
  app.get('/cliente',{onRequest:privateHeaders},(_request,reply)=>reply.sendFile('portal.html'));
  app.get('/cliente/:token',{onRequest:privateHeaders},(_request,reply)=>reply.sendFile('portal.html'));
  app.get('/privacidade',{onRequest:privateHeaders},(_request,reply)=>reply.sendFile('privacy.html'));
  return portal;
}
