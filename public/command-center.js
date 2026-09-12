const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[c],
  );
const value = (x) => x?.value ?? x ?? 'Não disponível';
const time = (x) => (x ? new Date(x).toLocaleString('pt-BR') : '—');
const calendarDate = (x) => {
  const raw = value(x);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
};
const age = (x) =>
  x
    ? `${Math.max(0, Math.floor((Date.now() - Date.parse(x)) / 60000))} min`
    : '—';
const badge = (status) => {
  const map = {
    TRIAGING: 'PROCESSING',
    AUTOMATED_RESOLUTION: 'PROCESSING',
    OPEN: 'HUMAN REQUIRED',
    IN_PROGRESS: 'HUMAN REQUIRED',
    ACKNOWLEDGED: 'HUMAN REQUIRED',
    HUMAN_REQUIRED: 'HUMAN REQUIRED',
    WAITING_CUSTOMER: 'WAITING CUSTOMER',
    WAITING_SYSTEM: 'PROCESSING',
    RESOLVED: 'RESOLVED',
    CLOSED: 'RESOLVED',
    DISMISSED: 'DISMISSED',
  };
  return `<span class="cc-badge ${['RESOLVED', 'CLOSED'].includes(status) ? 'cc-success' : status === 'HUMAN_REQUIRED' ? 'cc-attention' : ''}">${escape(map[status] || status)}</span>`;
};
const metric = (label, x, note = '') =>
  `<article class="cc-metric"><small>${escape(label)}</small><strong>${escape(x === null || x === undefined ? '—' : x)}</strong><span>${escape(note)}</span></article>`;
const field = (label, x) =>
  `<div class="cc-field"><dt>${escape(label)}</dt><dd>${escape(value(x))}</dd></div>`;
const ratio = (r) =>
  r?.value === null || r?.value === undefined
    ? '—'
    : `${(r.value * 100).toFixed(1)}%`;
const empty = (text) => `<p class="cc-empty">${escape(text)}</p>`;
const actionNames = {
  'support.case_opened': 'Abriu atendimento',
  'support.triaged': 'Classificou o problema',
  'support.resolution_attempted': 'Executou ação sintética',
  'support.verification_recorded': 'Verificou o resultado',
  'support.case_resolved': 'Resolveu o suporte',
  'support.human_required': 'Solicitou intervenção humana',
  'exception.created': 'Abriu exceção',
  'exception.resolved': 'Registrou resolução humana',
  'exception.acknowledged': 'Assumiu exceção',
};

export function createCommandCenter({
  api,
  document = globalThis.document,
  navigate = () => {},
  canManage = () => false,
}) {
  const find = (id) => document.getElementById(id);
  const state = {
    offset: 0,
    activityOffset: 0,
    conversationOffset: 0,
    caseOffset: 0,
    exception: null,
  };
  async function section(id, load, render) {
    const el = find(id);
    if (!el) return;
    el.setAttribute('aria-busy', 'true');
    try {
      el.innerHTML = render(await load());
    } catch {
      el.innerHTML =
        '<div class="cc-error" role="status">Não foi possível carregar esta seção. As outras áreas continuam disponíveis.</div>';
    } finally {
      el.setAttribute('aria-busy', 'false');
    }
  }
  function rows(items, exception = true) {
    return items
      .map(
        (
          row,
        ) => `<article class="cc-row"><div class="cc-row-head"><strong>${escape(row.customer_name || row.customer_id)}</strong>${badge(row.status)}</div>
      <p>${escape(row.summary)}</p><div class="cc-meta"><span>${escape(row.category)}</span><span>${escape(row.severity)}</span><span>Aberto há ${age(row.created_at)}</span></div>
      <p class="cc-recommendation">${escape(row.recommended_action || row.last_action || 'Consultar contexto do atendimento')}</p>
      <div class="cc-row-actions">${exception ? `<button class="btn btn-secondary btn-small" data-cc-exception="${escape(row.id)}" data-customer="${escape(row.customer_id)}">Revisar exceção →</button>` : ''}
      <button class="text-button" data-cc-customer="${escape(row.customer_id)}">Customer 360</button></div></article>`,
      )
      .join('');
  }
  async function dashboard() {
    await Promise.all([
      section(
        'ccSummary',
        () => api('/api/admin/command-center/summary'),
        (s) =>
          [
            metric('CLIENTES ATIVOS', s.active_customers),
            metric(
              'RECEITA CONFIRMADA',
              s.revenue_cents === null
                ? null
                : (s.revenue_cents / 100).toLocaleString('pt-BR', {
                    style: 'currency',
                    currency: 'BRL',
                  }),
              'Mês atual · fonte oficial',
            ),
            metric('RENOVAÇÕES', s.renewals),
            metric('PAGAMENTOS PENDENTES', s.pending_payments),
            metric('LEADS', s.leads),
            metric('CONVERSAS ATIVAS', s.active_conversations),
            metric('ATENDIMENTOS', s.support_cases),
            metric('RESOLVIDOS AUTOMATICAMENTE', s.automatically_resolved),
            metric('PRECISA DE VOCÊ', s.human_required),
            metric('FALHAS DE AUTOMAÇÃO', s.automation_failures),
          ].join(''),
      ),
      section(
        'ccMetrics',
        () => api('/api/admin/command-center/metrics'),
        (m) =>
          [
            metric(
              'AUTONOMOUS RESOLUTION RATE',
              ratio(m.autonomous_resolution_rate),
              `${m.autonomous_resolution_rate.numerator} / ${m.autonomous_resolution_rate.denominator} elegíveis · inclui falhas`,
            ),
            metric('HUMAN HANDOFF RATE', ratio(m.human_handoff_rate)),
            metric('AUTONOMOUS RENEWAL RATE', ratio(m.autonomous_renewal_rate)),
            metric('TOOL SUCCESS RATE', ratio(m.tool_success_rate)),
            metric('EXCEPTION RATE', ratio(m.exception_rate)),
            metric('REPEAT CONTACT RATE', ratio(m.repeat_contact_rate)),
            metric(
              'PRIMEIRA RESPOSTA',
              m.first_response_time === null
                ? null
                : `${Math.round(m.first_response_time)} ms`,
            ),
            metric(
              'TEMPO PARA RESOLVER',
              m.time_to_resolution === null
                ? null
                : `${Math.round(m.time_to_resolution)} ms`,
            ),
          ].join(''),
      ),
      section(
        'ccNeedsYou',
        () =>
          api(
            '/api/admin/command-center/exceptions?human_required=true&limit=3',
          ),
        (r) =>
          r.items.length
            ? rows(r.items)
            : empty('Nenhuma solicitação precisa da sua atenção agora.'),
      ),
      activity(),
    ]);
  }
  async function activity() {
    await section(
      'ccActivity',
      () =>
        api(
          `/api/admin/command-center/activity?limit=10&offset=${state.activityOffset}`,
        ),
      (r) => {
        find('ccActivityNext').disabled = !r.has_more;
        find('ccActivityPrevious').disabled = state.activityOffset === 0;
        return r.items.length
          ? `<ol class="cc-feed">${r.items.map((x) => `<li><time>${escape(time(x.timestamp))}</time><div><strong>${escape(actionNames[x.action] || x.action)}</strong><span>${escape(x.actor)} · ${escape(x.customer || 'Sistema')}</span><small>${escape(x.result || 'REGISTRADO')} · correlação ${escape(x.correlation_id?.slice(0, 8) || '—')}</small></div></li>`).join('')}</ol>`
          : empty('Nenhuma ação operacional registrada neste ambiente.');
      },
    );
  }
  async function inbox(reset = false) {
    if (reset) state.offset = 0;
    const form = find('ccFilters');
    const params = new URLSearchParams(new FormData(form));
    for (const [k, v] of [...params]) if (!v) params.delete(k);
    params.set('offset', state.offset);
    params.set('limit', '20');
    await section(
      'ccInbox',
      () => api(`/api/admin/command-center/exceptions?${params}`),
      (r) => {
        find('ccNext').disabled = !r.has_more;
        find('ccPrevious').disabled = state.offset === 0;
        find('ccPage').textContent =
          `Página ${Math.floor(state.offset / 20) + 1}`;
        return r.items.length
          ? rows(r.items)
          : empty('Nenhuma solicitação precisa da sua atenção agora.');
      },
    );
  }
  async function detail(customer, id) {
    find('ccDetailDialog').showModal();
    await section(
      'ccExceptionDetail',
      () =>
        api(
          `/api/admin/command-center/customers/${encodeURIComponent(customer)}/exceptions/${encodeURIComponent(id)}`,
        ),
      (e) => {
        state.exception = e;
        const ctx = e.context || {};
        const sub = ctx.subscription || {};
        return `<div class="cc-row-head"><h2>Atendimento com contexto</h2>${badge(e.status)}</div><dl class="cc-detail-grid">
        ${field('CLIENTE', ctx.identity?.name || e.customer_id)}${field('PROBLEMA', e.summary)}${field('CATEGORIA', e.category)}${field('SEVERIDADE', e.severity)}
        ${field('CONTEXTO · ASSINATURA', sub.status)}${field('VENCIMENTO', calendarDate(sub.expires_at))}${field('PAYMENT', ctx.operational?.payment?.status || ctx.financial?.last_payment?.status)}${field('RENEWAL', ctx.operational?.renewal?.renewal_status || ctx.renewal?.status)}
        ${field('DIAGNÓSTICO', e.diagnosis)}${field('MOTIVO DA FALHA', e.reason_code)}${field('RISCO', e.risk)}${field('RECOMENDAÇÃO', e.recommended_action)}${field('AÇÃO POSSÍVEL', e.possible_action)}${field('CORRELAÇÃO', e.correlation_id)}</dl>
        <h3>TENTATIVAS · TOOLS · RESULTADOS</h3>${e.attempts?.length ? `<ol class="cc-attempts">${e.attempts.map((a) => `<li>${escape(a.tool)} · ${escape(a.action)} · ${escape(a.result)} · ${escape(time(a.timestamp))}</li>`).join('')}</ol>` : empty('Nenhuma ação executada. A política encaminhou o caso antes da execução.')}
        <h3>TRILHA DE TOOLS E POLICY</h3>${e.tools_used?.length ? `<ol class="cc-attempts">${e.tools_used.map((t) => `<li>${escape(t.tool || t)} · ${escape(t.policy || '—')} · ${escape(t.status || '—')} ${escape(t.error_code || '')}</li>`).join('')}</ol>` : empty('Nenhuma tool registrada antes do encaminhamento.')}
        ${e.human_result ? `<h3>RESOLUÇÃO HUMANA</h3><p>${escape(e.human_result.note)} · ${escape(e.human_result.actor.id)}</p>` : ''}
        <div class="cc-row-actions"><button class="btn btn-secondary" data-cc-customer="${escape(e.customer_id)}">Abrir Customer 360</button><button class="btn btn-secondary" data-cc-conversation="${escape(e.customer_id)}">Abrir conversa</button></div>
        ${
          canManage() && !['RESOLVED', 'DISMISSED'].includes(e.status)
            ? `<label class="cc-note">Resultado verificado / justificativa<textarea id="ccHumanNote" maxlength="2000" rows="3" placeholder="Descreva o que foi feito e a evidência do resultado."></textarea></label><div class="cc-row-actions">${[
                ['claim', 'Assumir'],
                ['wait', 'Aguardar cliente'],
                ['resolve', 'Resolver com verificação'],
                ['dismiss', 'Dispensar'],
              ]
                .map(
                  ([action, label]) =>
                    `<button class="btn btn-secondary" data-cc-action="${action}">${label}</button>`,
                )
                .join('')}</div>`
            : '<p class="muted">Ações de gestão restritas a administradores autorizados.</p>'
        }<p id="ccActionResult" role="status"></p>`;
      },
    );
  }
  async function customer(id) {
    if (find('ccDetailDialog').open) find('ccDetailDialog').close();
    find('ccCustomerDialog').showModal();
    await section(
      'ccCustomerDetail',
      () =>
        api(`/api/admin/command-center/customers/${encodeURIComponent(id)}`),
      (result) => {
        const c = result.customer360;
        const s = c.subscription || {};
        return `<h2>Customer 360</h2><p class="muted">Customer360.v1 · fontes oficiais · ${escape(c.customer_id)}</p><dl class="cc-detail-grid">${field('IDENTIDADE', c.identity?.name)}${field('LIFECYCLE', c.lifecycle?.state)}${field('PLANO', s.plan_name)}${field('VENCIMENTO', calendarDate(s.expires_at))}${field('PAYMENT', c.financial?.last_payment?.status)}${field('RENEWAL', c.renewal?.status)}${field('CONVERSA', c.conversation?.state)}</dl>
        <h3>SUPPORT CASES</h3>${(c.support?.recent_cases || []).map((x) => `<article class="cc-row">${badge(x.status)}<p>${escape(x.summary)}</p><p>${escape(x.resolution || x.diagnosis || 'Em análise')}</p></article>`).join('') || empty('Nenhum caso registrado.')}
        <h3>EXCEPTIONS</h3>${(c.support?.exceptions || []).map((x) => `<p>${badge(x.status)} ${escape(x.reason_code)}</p>`).join('') || empty('Nenhuma exceção registrada.')}
        <h3>MEMÓRIA VALIDADA</h3>${(c.memories || []).map((x) => `<p>${escape(x.key)}: ${escape(typeof x.value === 'object' ? JSON.stringify(x.value) : x.value)}</p>`).join('') || empty('Nenhuma memória selecionada para este contexto.')}
        <h3>HISTÓRICO DE AÇÕES DO GATE</h3>${result.activity.items.map((x) => `<p>${escape(time(x.timestamp))} · ${escape(actionNames[x.action] || x.action)} · ${escape(x.result)}</p>`).join('') || empty('Nenhuma ação registrada.')}`;
      },
    );
  }
  async function conversations(customerId = '') {
    await section(
      'ccConversations',
      () =>
        api(
          `/api/admin/command-center/conversations?limit=20&offset=${state.conversationOffset}${customerId ? `&customer_id=${encodeURIComponent(customerId)}` : ''}`,
        ),
      (r) => {
        find('ccConversationsNext').disabled = !r.has_more;
        find('ccConversationsPrevious').disabled = !state.conversationOffset;
        return r.items.length
          ? r.items
              .map(
                (x) =>
                  `<article class="cc-row"><div class="cc-row-head"><strong>${escape(x.customer_name)}</strong>${badge(x.status)}</div><dl class="cc-detail-grid">${field('INTENT', x.intent)}${field('AGENT', x.agent)}${field('CONVERSATION', x.conversation_id)}${field('SUPPORT CASE', x.support_case_id)}${field('EXCEPTION', x.exception_id)}${field('HANDOFF', x.handoff ? 'HUMAN REQUIRED' : 'AUTOMATED')}${field('ÚLTIMA AÇÃO', x.last_action)}</dl><button class="text-button" data-cc-customer="${escape(x.customer_id)}">Customer 360 →</button></article>`,
              )
              .join('')
          : empty('Nenhum atendimento autônomo registrado.');
      },
    );
  }
  async function cases() {
    await section(
      'ccCases',
      () =>
        api(
          `/api/admin/command-center/cases?limit=20&offset=${state.caseOffset}`,
        ),
      (r) => {
        find('ccCasesNext').disabled = !r.has_more;
        find('ccCasesPrevious').disabled = !state.caseOffset;
        return r.items.length
          ? rows(r.items, false)
          : empty('Nenhum caso de suporte neste ambiente.');
      },
    );
  }
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.ccException)
      return detail(button.dataset.customer, button.dataset.ccException);
    if (button.dataset.ccCustomer) return customer(button.dataset.ccCustomer);
    if (button.dataset.ccConversation) {
      find('ccDetailDialog').close();
      await navigate('conversations');
      return conversations(button.dataset.ccConversation);
    }
    if (button.dataset.ccClose) return find(button.dataset.ccClose).close();
    if (button.dataset.ccAction && state.exception) {
      const e = state.exception,
        action = button.dataset.ccAction;
      const note = find('ccHumanNote').value;
      if (['resolve', 'dismiss'].includes(action) && note.trim().length < 10) {
        find('ccActionResult').textContent =
          'Informe uma justificativa com pelo menos 10 caracteres.';
        return;
      }
      button.disabled = true;
      try {
        await api(
          `/api/admin/command-center/customers/${e.customer_id}/exceptions/${e.id}/${action}`,
          {
            method: 'POST',
            body: JSON.stringify({
              note,
              ...(action === 'resolve' ? { result: 'VERIFIED' } : {}),
            }),
          },
        );
        find('ccDetailDialog').close();
        await inbox();
        await dashboard();
      } catch (error) {
        find('ccActionResult').textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }
  });
  find('ccFilters')?.addEventListener('submit', (event) => {
    event.preventDefault();
    inbox(true);
  });
  for (const [prev, next, key, size, load] of [
    ['ccPrevious', 'ccNext', 'offset', 20, inbox],
    ['ccActivityPrevious', 'ccActivityNext', 'activityOffset', 10, activity],
    [
      'ccConversationsPrevious',
      'ccConversationsNext',
      'conversationOffset',
      20,
      conversations,
    ],
    ['ccCasesPrevious', 'ccCasesNext', 'caseOffset', 20, cases],
  ]) {
    find(prev)?.addEventListener('click', () => {
      state[key] = Math.max(0, state[key] - size);
      load();
    });
    find(next)?.addEventListener('click', () => {
      state[key] += size;
      load();
    });
  }
  return { dashboard, inbox, detail, customer, conversations, cases };
}
