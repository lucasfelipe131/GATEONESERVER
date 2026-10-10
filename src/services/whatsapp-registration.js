import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizePhone } from '../security.js';
import { cleanCustomerName } from './customer-memory.js';
import { PgConversationAgentRepository } from './conversation-operations.js';

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
const start = text => /^(6|CADASTRO|AUTO ?CADASTRO|ME CADASTRAR|QUERO ME CADASTRAR|ATUALIZAR( MEUS)? DADOS|COMPLETAR( MEU)? CADASTRO|FAZER( MEU)? CADASTRO|QUERO ASSINAR|QUERO CONTRATAR|AINDA NAO SOU CLIENTE)$/.test(text);
const skip = text => /^(PULAR|NAO TENHO|NAO SEI|SEM EMAIL|DEPOIS)$/.test(text);
const planCodes = { MENSAL: 'monthly', TRIMESTRAL: 'quarterly', SEMESTRAL: 'semiannual', ANUAL: 'annual' };
const interrupts = text => /^(MENU|0|4|7|ATENDENTE|HUMANO|SUPORTE)$/.test(text) ||
  /\b(FALAR COM|QUERO FALAR|PRECISO DE UM ATENDENTE|PAGUEI|PIX|BOLETO|CARTAO|PAGAR|FORMAS DE PAGAMENTO|RENOVAR|VENCIMENTO|TRAVANDO|SEM SINAL)\b/.test(text);
const cleanField = text => String(text).replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

function question(draft, customer, plans) {
  switch (draft.step) {
    case 'KIND': return 'Vamos fazer seu cadastro por aqui. Este número de WhatsApp já identifica o contato. Você já é cliente? Responda *1* para já sou cliente ou *2* para cliente novo.';
    case 'LOGIN': return 'Qual é o seu *login/ID do Gate One*? Envie apenas o login, nunca a senha. Se não souber, responda *NÃO SEI*; seus dados podem ser preenchidos enquanto a equipe confere o vínculo.';
    case 'NAME': return `Qual é o seu *nome completo*?${customer.name ? ' Se o nome cadastrado continua correto, responda *MANTER*.' : ''}`;
    case 'EMAIL': return 'Qual é seu *e-mail de contato*? É opcional: responda *PULAR* se não quiser informar, ou *MANTER* para conservar o atual.';
    case 'DEVICE': return 'Em qual aparelho você usa ou pretende usar o serviço? Informe a marca/modelo, por exemplo *TV Samsung*, *TV LG*, *TV Box* ou *celular*.';
    case 'APPLICATION': return 'Qual é o nome do aplicativo usado nesse aparelho? Se ainda não tiver aplicativo ou não souber, responda *PULAR*.';
    case 'PLAN': return `Qual plano você tem interesse em contratar? Isso registra uma preferência, sem cobrança ou ativação.\n${plans.map(p => `• *${p.name}* — ${(p.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`).join('\n')}\nResponda *MENSAL*, *TRIMESTRAL*, *SEMESTRAL*, *ANUAL* ou *DEPOIS*.`;
    case 'CONSENT': return 'Você autoriza receber avisos de vencimento e atendimento neste WhatsApp? Responda *SIM* ou *NÃO*. Você pode pedir para parar os avisos depois.';
    case 'REVIEW': return `Confira antes de salvar:\nNome: ${draft.name}\nE-mail: ${draft.email || 'não informado'}\nAparelho: ${draft.device}\nAplicativo: ${draft.application || 'não informado'}\n${draft.plan_code ? `Plano de interesse: ${plans.find(p => p.code === draft.plan_code)?.name || draft.plan_code}\n` : ''}Avisos neste WhatsApp: ${draft.consent ? 'autorizados' : 'não autorizados'}\n\nResponda *CONFIRMAR* para salvar, *CORRIGIR* para revisar ou *CANCELAR CADASTRO* para descartar. Nenhum plano será alterado e nenhum pagamento será criado por este cadastro.`;
    default: throw new Error('REGISTRATION_STATE_INVALID');
  }
}

// The transport verifies the WhatsApp sender. The customer is always resolved
// from that phone; supplied customer IDs, names and claimed logins never grant access.
export async function processWhatsAppRegistration(db, { phone, text, messageId, now = new Date() }) {
  const normalizedPhone = normalizePhone(phone);
  const command = normalize(text);
  return db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`registration:${normalizedPhone}`]);
    const customer = (await client.query('SELECT id,name,email,consent_contact,opt_out_at FROM customers WHERE whatsapp_e164=$1 FOR UPDATE', [normalizedPhone])).rows[0];
    if (!customer) return { handled: false };
    const key = `self-registration:${customer.id}:${createHash('sha256').update(messageId).digest('hex')}`;
    const previous = (await client.query('SELECT response_text,response_facts FROM agent_decisions WHERE idempotency_key=$1 AND customer_id=$2', [key, customer.id])).rows[0];
    if (previous) return { handled: true, response_text: previous.response_text, ...previous.response_facts, duplicate: true };
    const session = (await client.query('SELECT data FROM conversation_sessions WHERE whatsapp_e164=$1 FOR UPDATE', [normalizedPhone])).rows[0];
    if (!session) return { handled: false };
    let draft = session.data?.self_registration || null;
    if (draft && (draft.customer_id !== customer.id || new Date(draft.expires_at) <= now)) draft = null;
    const cancelled = /^(CANCELAR CADASTRO|SAIR DO CADASTRO)$/.test(command);
    if (!start(command) && !draft && !cancelled) return { handled: false };
    if (draft && interrupts(command)) return { handled: false };
    const plans = (await client.query('SELECT code,name,price_cents FROM plans WHERE active=true ORDER BY sort_order')).rows;
    const correlationId = randomUUID();
    let response;
    let outcome = 'REGISTRATION_COLLECTING';
    if (cancelled) {
      draft = null;
      response = 'O preenchimento do cadastro foi cancelado. Os dados anteriores da sua conta continuam preservados. Para recomeçar, envie *CADASTRO*.';
      outcome = 'REGISTRATION_CANCELLED';
    } else if (!draft || start(command)) {
      const linked = (await client.query('SELECT 1 FROM subscriptions WHERE customer_id=$1 LIMIT 1', [customer.id])).rowCount > 0;
      draft = { version: 1, customer_id: customer.id, step: linked ? 'NAME' : 'KIND', kind: linked ? 'existing' : null,
        expires_at: new Date(now.getTime() + 86_400_000).toISOString() };
      response = question(draft, customer, plans);
    } else if (/^(CONTINUAR CADASTRO|CONTINUAR|OI|OLA|BOM DIA|BOA TARDE|BOA NOITE)$/.test(command)) {
      response = question(draft, customer, plans);
    } else {
      let error = null;
      switch (draft.step) {
        case 'KIND':
          if (/^(1|SIM|JA SOU CLIENTE|CLIENTE ATUAL)$/.test(command)) { draft.kind = 'existing'; draft.step = 'LOGIN'; }
          else if (/^(2|NAO|CLIENTE NOVO|SOU NOVO|NOVO)$/.test(command)) { draft.kind = 'new'; draft.step = 'NAME'; }
          else error = 'Responda *1* para já sou cliente ou *2* para cliente novo.';
          break;
        case 'LOGIN': {
          const login = String(text).trim().toLowerCase();
          if (!skip(command) && (!/^[a-z0-9._@-]{3,80}$/i.test(login))) { error = 'Envie apenas seu login/ID, sem senha, ou responda *NÃO SEI*.'; break; }
          const candidates = skip(command) ? [] : (await client.query('SELECT id FROM customers WHERE lower(trim(bitpanel_reference))=$1 LIMIT 2', [login])).rows;
          if (candidates.length === 1 && candidates[0].id === customer.id) draft.login_verified = true;
          else {
            // An unverified claim must not link a new phone or disclose another account.
            const repository = new PgConversationAgentRepository({ query: (...args) => client.query(...args), transaction: callback => callback(client) });
            const handoff = await repository.requestHandoff({ conversation_id: `whatsapp:${normalizedPhone.replace(/\D/g, '')}`,
              customer_id: customer.id, correlation_id: correlationId, reason: 'SELF_REGISTRATION_IDENTITY_REVIEW',
              summary: 'Cliente informou um vínculo existente durante o autocadastro. Validar a identidade antes de associar outra conta.',
              requested_by: { type: 'SERVICE', id: 'whatsapp-self-registration' }, idempotency_key: `${key}:identity-review` });
            draft.handoff_id = handoff.handoff_id;
            if (!skip(command)) {
              draft.claimed_login = login;
              await client.query(`INSERT INTO customer_identity_links(whatsapp_e164,source_customer_id,candidate_customer_id,claimed_login,status,reason,confidence)
                VALUES($1,$2,$3,$4,'pending','self_registration_unverified',0)
                ON CONFLICT(whatsapp_e164,lower(claimed_login)) WHERE status='pending' DO UPDATE SET updated_at=now()`,
              [normalizedPhone, customer.id, candidates.length === 1 ? candidates[0].id : null, login]);
            }
          }
          draft.step = 'NAME';
          break;
        }
        case 'NAME':
          draft.name = command === 'MANTER' ? cleanCustomerName(customer.name) : cleanCustomerName(text);
          if (!draft.name || /^(OI|OLA|SIM|NAO|CONFIRMAR|MENU|CADASTRO|PIX|RENOVAR)$/.test(normalize(draft.name))) error = 'Informe seu nome completo, usando letras, ou responda *MANTER* se já estiver cadastrado.';
          else draft.step = 'EMAIL';
          break;
        case 'EMAIL': {
          const email = command === 'MANTER' || skip(command) ? customer.email : String(text).trim().toLowerCase();
          if (email && !z.email().max(254).safeParse(email).success) error = 'Esse e-mail não parece válido. Confira o endereço ou responda *PULAR*.';
          else { draft.email = email || null; draft.step = 'DEVICE'; }
          break;
        }
        case 'DEVICE':
          if (String(text).trim().length < 2 || String(text).trim().length > 100) error = 'Informe a marca/modelo do aparelho em até 100 caracteres.';
          else { draft.device = cleanField(text); draft.step = 'APPLICATION'; }
          break;
        case 'APPLICATION':
          if (String(text).trim().length > 100) error = 'Informe só o nome do aplicativo, em até 100 caracteres, ou responda *PULAR*.';
          else { draft.application = skip(command) ? null : cleanField(text); draft.step = draft.kind === 'new' ? 'PLAN' : 'CONSENT'; }
          break;
        case 'PLAN':
          if (skip(command)) { draft.plan_code = null; draft.step = 'CONSENT'; }
          else if (planCodes[command] && plans.some(p => p.code === planCodes[command])) { draft.plan_code = planCodes[command]; draft.step = 'CONSENT'; }
          else error = 'Escolha um dos planos disponíveis ou responda *DEPOIS*.';
          break;
        case 'CONSENT':
          if (!/^(SIM|NAO)$/.test(command)) error = 'Responda *SIM* para autorizar os avisos ou *NÃO* para não autorizar.';
          else { draft.consent = command === 'SIM'; draft.step = 'REVIEW'; }
          break;
        case 'REVIEW':
          if (command === 'CORRIGIR') { draft.step = 'NAME'; break; }
          if (command !== 'CONFIRMAR') { error = 'Responda *CONFIRMAR*, *CORRIGIR* ou *CANCELAR CADASTRO*.'; break; }
          await client.query(`UPDATE customers SET name=$2,email=$3,name_confirmed_at=now(),consent_contact=$4,
            opt_out_at=CASE WHEN $4 THEN NULL ELSE COALESCE(opt_out_at,now()) END,updated_at=now() WHERE id=$1 AND whatsapp_e164=$5`,
          [customer.id, draft.name, draft.email, draft.consent, normalizedPhone]);
          await client.query(`INSERT INTO customer_memories(customer_id,memory_type,memory_key,value,source,source_reference,confidence,observed_at)
            VALUES($1,'PREFERENCE','self_registration.profile',$2::jsonb,'WHATSAPP_SELF_REGISTRATION',$3,'HIGH',now())
            ON CONFLICT(customer_id,memory_type,memory_key) WHERE status='ACTIVE'
            DO UPDATE SET value=EXCLUDED.value,source=EXCLUDED.source,source_reference=EXCLUDED.source_reference,observed_at=now(),updated_at=now()`,
          [customer.id, JSON.stringify({ device: draft.device, application: draft.application, kind: draft.kind,
            requested_plan: draft.plan_code || null, completed_at: now.toISOString(), customer_reported: true }), messageId]);
          response = draft.handoff_id
            ? 'Seus dados de contato e aparelho foram salvos. O vínculo com o login aguarda conferência da equipe; nenhuma outra conta foi alterada. O atendimento está registrado para a equipe.'
            : draft.kind === 'new'
              ? 'Cadastro salvo! Registrei seu contato, aparelho e preferência de plano. Envie *PLANOS* para consultar os valores ou *ATENDENTE* para a equipe conferir e preparar seu primeiro acesso. Este cadastro não ativou uma assinatura nem gerou uma cobrança.'
              : 'Dados atualizados! Já guardei o aparelho e o aplicativo para o atendimento. Você pode enviar *VENCIMENTO*, *QUERO RENOVAR* ou descrever o problema que precisa resolver.';
          outcome = 'REGISTRATION_COMPLETED';
          draft = null;
          break;
        default: throw new Error('REGISTRATION_STATE_INVALID');
      }
      if (!response) response = error ? `${error}\n\nPara retomar depois, envie *CONTINUAR CADASTRO*.` : question(draft, customer, plans);
    }
    await client.query(`UPDATE conversation_sessions SET data=jsonb_set(COALESCE(data,'{}'::jsonb),'{self_registration}',$2::jsonb),
      revision=revision+1,updated_at=now() WHERE whatsapp_e164=$1`, [normalizedPhone, JSON.stringify(draft)]);
    const facts = { outcome, registration_step: draft?.step || null };
    await client.query(`INSERT INTO agent_decisions(decision_id,conversation_id,customer_id,message_id,correlation_id,intents,confidence,
      policy_result,response_status,response_facts,response_text,outcome,prompt_version,autonomous,eligible_for_automation,idempotency_key)
      VALUES($1,$2,$3,$4,$5,'[{"name":"PROFILE_REGISTRATION","confidence":"HIGH"}]'::jsonb,'HIGH','ALLOW','VALIDATED',$6::jsonb,$7,$8,'whatsapp-registration.v1',false,false,$9)`,
    [randomUUID(), `whatsapp:${normalizedPhone.replace(/\D/g, '')}`, customer.id, messageId, correlationId, JSON.stringify(facts), response, outcome, key]);
    return { handled: true, response_text: response, ...facts };
  });
}
