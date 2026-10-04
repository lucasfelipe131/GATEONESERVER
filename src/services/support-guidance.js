import { mergeResponseFacts } from '../core/conversation-responses.js';
import { detectCustomerIssue } from './customer-memory.js';

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
const field = value => String(value || '').replace(/[\r\n]/g, ' ').trim().slice(0, 100);
const valueOf = value => value?.value ?? value;
const states = new Set(['support_device', 'support_application', 'support_scope', 'support_result']);

// Production support offers reversible client-side checks. It has no provider
// actuator and never turns the client's report into a verified resolution.
export class GuidedSupportAgent {
  async handle({ turn, customerId, customer360, intentResult, text, conversationId,
    contextSnapshotId, correlationId, idempotencyKey, facts, recentDecisions = [] }) {
    const handoff = async (reason, summary, support = {}) => {
      const result = await turn.execute('requestHumanHandoff', {
        conversation_id: conversationId, customer_id: customerId, context_snapshot_id: contextSnapshotId,
        correlation_id: correlationId, reason, intent: intentResult, summary,
        idempotency_key: `${idempotencyKey}:handoff`
      });
      return { facts: mergeResponseFacts(facts, { ...support, handoff_id: result.handoff_id }),
        outcome: 'HANDOFF_CREATED', autonomous: false, eligible: false, conversationState: 'human_handoff' };
    };
    if (['HUMAN_REQUEST', 'COMPLAINT', 'CANCELLATION_REQUEST'].includes(intentResult.primary_intent)) {
      return handoff(intentResult.primary_intent, `Cliente solicitou continuidade humana: ${field(text)}`);
    }
    const prior = recentDecisions[0]?.response_facts;
    const continuing = states.has(prior?.conversation_state) && prior?.customer_id === customerId;
    const profile = customer360?.memories?.find(memory => memory.key === 'self_registration.profile' &&
      memory.source === 'WHATSAPP_SELF_REGISTRATION')?.value || {};
    const issue = detectCustomerIssue(text);
    const session = continuing && prior.support_session ? { ...prior.support_session } : {
      problem: field(text), category: issue?.category || 'connection',
      device: profile.device || null, application: profile.application || null, scope: null
    };
    let step = continuing ? prior.conversation_state : null;
    let reply;
    if (continuing && !issue) {
      if (step === 'support_device') {
        if (String(text).trim().length < 2 || String(text).trim().length > 100) reply = 'Informe a marca/modelo do aparelho em até 100 caracteres, por exemplo TV Samsung ou TV Box.';
        else { session.device = field(text); step = null; }
      } else if (step === 'support_application') {
        if (String(text).trim().length < 2 || String(text).trim().length > 100) reply = 'Qual é o nome do aplicativo? Se não souber, responda NÃO SEI.';
        else { session.application = /^(NAO SEI|PULAR)$/.test(normalize(text)) ? 'não informado' : field(text); step = null; }
      } else if (step === 'support_scope') {
        if (/^(1|TUDO|TODOS|EM TUDO|TODOS OS CANAIS|NAO SEI)$/.test(normalize(text))) session.scope = 'ALL';
        else if (/^(2|UM|SO UM|APENAS UM)$/.test(normalize(text)) || /\b(SO|SOMENTE|APENAS)\b/.test(normalize(text))) session.scope = 'ONE';
        else reply = 'Isso acontece em tudo ou em apenas um canal/conteúdo? Responda 1 para tudo ou 2 para apenas um.';
        if (session.scope) step = 'support_result';
      }
    }
    const openCases = await turn.execute('getOpenSupportCases', { customer_id: customerId });
    const support = openCases[0] || await turn.execute('openSupportCase', {
      customer_id: customerId, category: 'TECHNICAL_SUPPORT', summary: `Suporte guiado: ${session.problem}`,
      message: session.problem, correlation_id: correlationId, idempotency_key: `${idempotencyKey}:support`
    });
    const supportFacts = { support_case_id: support.support_case_id || support.id, support_session: session };
    if (continuing && prior.conversation_state === 'support_result') {
      if (/^(SIM|FUNCIONOU|VOLTOU|DEU CERTO|RESOLVEU|AGORA SIM|AGORA ESTA FUNCIONANDO)$/.test(normalize(text))) {
        return { facts: mergeResponseFacts(facts, { ...supportFacts, verification_result: 'CUSTOMER_REPORTED',
          support_reply: 'Obrigado por confirmar que agora está funcionando. Seu relato ficou no histórico do atendimento. Se acontecer novamente, descreva o erro para continuarmos daqui.' }),
          outcome: 'CUSTOMER_REPORTED_RECOVERY', autonomous: true, eligible: false, conversationState: null };
      }
      if (/\b(NAO|CONTINUA|AINDA|MESMO|PERSISTE|NAO FUNCIONOU)\b/.test(normalize(text)) || issue) {
        return handoff('GUIDED_SUPPORT_UNRESOLVED', `Verificações básicas não resolveram. Problema: ${session.problem}; aparelho: ${session.device}; aplicativo: ${session.application}; alcance: ${session.scope}. Relato: ${field(text)}`, supportFacts);
      }
      reply = 'Depois dessas verificações, ficou funcionando? Responda SIM ou NÃO. Se persistir, a equipe receberá o aparelho, aplicativo e o que já foi testado.';
      step = 'support_result';
    }
    if (!reply) {
      if (!session.device) { step = 'support_device'; reply = 'Vou ajudar a verificar. Qual é a marca/modelo do aparelho em que ocorre o problema? Por exemplo TV Samsung, TV LG, TV Box ou celular.'; }
      else if (!session.application) { step = 'support_application'; reply = `Certo, aparelho ${session.device}. Qual é o nome do aplicativo usado nele? Se não souber, responda NÃO SEI.`; }
      else if (!session.scope) { step = 'support_scope'; reply = `Vou usar os dados: aparelho ${session.device}, aplicativo ${session.application}. O problema acontece em tudo ou em apenas um canal/conteúdo? Responda 1 para tudo ou 2 para apenas um.`; }
      else {
        step = 'support_result';
        if (session.category === 'login') reply = 'Confira se o login foi digitado sem espaços e feche e abra o aplicativo. Não envie sua senha. Se aparecer um código de erro, anote-o para a equipe.';
        else if (session.scope === 'ONE') reply = 'Teste outro canal/conteúdo no mesmo aplicativo, depois feche e abra o aplicativo e tente o conteúdo afetado novamente. Não apague o aplicativo nem altere seu login.';
        else reply = `No ${session.device}, confira se outro aplicativo, como o YouTube, acessa a internet. Depois feche e abra ${session.application === 'não informado' ? 'o aplicativo' : session.application}. Se continuar, desligue o aparelho por 30 segundos e ligue novamente. Não apague o aplicativo nem altere seu login.`;
        const expires = valueOf(customer360?.subscription?.expires_at);
        const status = valueOf(customer360?.subscription?.status);
        if (expires && ['late','expired','suspended'].includes(status)) reply += ' Seu cadastro também indica uma pendência na assinatura. As verificações acima não renovam o acesso; envie VENCIMENTO ou ATENDENTE para conferir.';
        reply += '\n\nDepois dessas verificações, ficou funcionando? Responda SIM ou NÃO.';
      }
    }
    return { facts: mergeResponseFacts(facts, { ...supportFacts, support_reply: reply }), outcome: 'SUPPORT_GUIDANCE',
      autonomous: true, eligible: false, conversationState: step };
  }
}
