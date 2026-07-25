const state = {
  user: null,
  summary: null,
  settings: null,
  chargeStatus: '',
  customers: []
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const money = (cents = 0) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const date = (value) =>
  value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`)) : '—';
const dateTime = (value) =>
  value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && options.body !== null && !(options.body instanceof FormData) && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/auth/login') showLogin();
  if (!response.ok) throw new Error(body.error || body.message || 'Não foi possível concluir.');
  return body;
}

function toast(message, type = '') {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (element.className = 'toast'), 3400);
}

function showLogin() {
  $('#loginShell').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
}

function showApp() {
  $('#loginShell').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  $('#adminName').textContent = state.user.name.split(/\s+/)[0];
  $('#avatar').textContent = state.user.name.slice(0, 1).toUpperCase();
}

const titles = {
  dashboard: ['CENTRAL DE CONTROLE', 'Visão geral'],
  customers: ['BASE DE ASSINANTES', 'Clientes'],
  charges: ['APROVAÇÃO E PIX', 'Cobranças'],
  renewals: ['AUTOMAÇÃO BITPANEL', 'Renovações'],
  leads: ['VENDAS AUTOMÁTICAS', 'Captação'],
  settings: ['SEGURANÇA E INTEGRAÇÕES', 'Configurações']
};

async function navigate(page) {
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $$('.page').forEach((panel) => panel.classList.toggle('active', panel.dataset.pagePanel === page));
  $('#pageEyebrow').textContent = titles[page][0];
  $('#pageTitle').textContent = titles[page][1];
  $('#sidebar').classList.remove('open');
  if (page === 'dashboard') await loadDashboard();
  if (page === 'customers') await loadCustomers();
  if (page === 'charges') await loadCharges();
  if (page === 'renewals') await loadRenewals();
  if (page === 'leads') await loadLeads();
  if (page === 'settings') await loadSettings();
}

function statusTag(status) {
  const map = {
    active: ['Ativo', 'green'],
    paid: ['Pago', 'green'],
    completed: ['Concluída', 'green'],
    converted: ['Convertido', 'green'],
    sent: ['Enviada', 'blue'],
    approved: ['Aprovada', 'blue'],
    queued: ['Na fila', 'blue'],
    running: ['Executando', 'blue'],
    awaiting_approval: ['Aguardando aprovação', 'amber'],
    payment_pending: ['Aguardando Pix', 'amber'],
    new: ['Novo', 'blue'],
    engaged: ['Em conversa', 'blue'],
    simulated: ['Simulação', 'amber'],
    late: ['Atrasado', 'amber'],
    manual_review: ['Revisão manual', 'red'],
    failed: ['Falhou', 'red'],
    rejected: ['Rejeitada', 'red'],
    suspended: ['Suspenso', 'red'],
    cancelled: ['Cancelado', 'red']
  };
  const [label, color] = map[status] || [status || '—', ''];
  return `<span class="tag ${color}">${escapeHtml(label)}</span>`;
}

async function loadDashboard() {
  const [summary, charges, settings] = await Promise.all([
    api('/api/admin/summary'),
    api('/api/admin/charges?status=awaiting_approval'),
    api('/api/admin/settings')
  ]);
  state.summary = summary;
  state.settings = settings;
  $('#metrics').innerHTML = [
    ['Clientes ativos', summary.customers, '◎', 'base total'],
    ['Para aprovar', summary.charges.awaiting, '◇', 'cobranças pendentes'],
    ['Renovações', summary.renewals, '↻', 'exigem atenção'],
    ['Receita do mês', money(summary.revenueCents), 'R$', 'pagamentos confirmados']
  ]
    .map(
      ([label, value, icon, note]) => `
      <article class="metric">
        <div class="metric-top"><span>${label}</span><span class="metric-icon">${icon}</span></div>
        <strong>${escapeHtml(value)}</strong><small>${note}</small>
      </article>`
    )
    .join('');
  $('#dashboardCharges').innerHTML = charges.charges.length
    ? charges.charges
        .slice(0, 5)
        .map(
          (charge) => `
          <div class="queue-row">
            <div><strong>${escapeHtml(charge.customer_name)}</strong><small>${escapeHtml(charge.plan_name)} · vence ${date(charge.due_on)}</small></div>
            <span class="queue-value">${money(charge.amount_cents)}</span>
          </div>`
        )
        .join('')
    : '<div class="empty">Nenhuma cobrança aguardando aprovação.</div>';
  renderIntegrations('#integrationStatus', settings.integrations);
  updateSafety(summary.settings.globalPause);
}

function renderIntegrations(target, integrations) {
  const labels = {
    redis: ['Fila Redis', 'Processamento em segundo plano'],
    mercadoPago: ['Mercado Pago', 'Cobrança Pix e confirmação'],
    whatsapp: ['WhatsApp Cloud API', 'Atendimento e lembretes'],
    bitpanel: ['BitPanel', 'Renovação por navegador']
  };
  $(target).innerHTML = Object.entries(labels)
    .map(
      ([key, [title, note]]) => `
      <div class="integration">
        <div><strong>${title}</strong><small>${note}</small></div>
        <span class="status-dot ${integrations[key] ? 'ready' : ''}">${integrations[key] ? 'Configurado' : 'Pendente'}</span>
      </div>`
    )
    .join('');
}

function updateSafety(paused) {
  const badge = $('#safetyBadge');
  badge.className = `safety-badge ${paused ? '' : 'live'}`;
  badge.innerHTML = `<span></span>${paused ? 'Automações pausadas' : 'Automações liberadas'}`;
}

async function loadCustomers(search = '') {
  const { customers } = await api(`/api/admin/customers?search=${encodeURIComponent(search)}`);
  state.customers = customers;
  $('#customersTable').innerHTML = customers.length
    ? customers
        .map(
          (customer) => `
          <tr>
            <td class="client-cell"><strong>${escapeHtml(customer.name || customer.bitpanel_reference || 'A preencher')}</strong><small>${escapeHtml(customer.whatsapp_masked || 'Telefone a preencher')}</small></td>
            <td>${escapeHtml(customer.plan_name || 'Sem plano')}</td>
            <td>${date(customer.expires_on)}</td>
            <td>${customer.bitpanel_list_id ? `<span class="tag blue">Lista ${escapeHtml(customer.bitpanel_list_id)}</span>` : '<span class="tag">Não vinculado</span>'}</td>
            <td>${escapeHtml(customer.bitpanel_owner || 'Gate One Pro Server')}${customer.automation_eligible === false ? '<small class="blocked-note">Automação bloqueada</small>' : ''}</td>
            <td>${statusTag(customer.status)}</td>
            <td><div class="table-actions"><button class="btn btn-secondary btn-small" data-edit-customer="${escapeHtml(customer.id)}">Editar</button><button class="btn btn-secondary btn-small" data-portal="${escapeHtml(customer.id)}">Copiar acesso</button></div></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="7"><div class="empty">Nenhum cliente encontrado.</div></td></tr>';
}

async function loadCharges(status = state.chargeStatus) {
  state.chargeStatus = status;
  const { charges } = await api(`/api/admin/charges?status=${encodeURIComponent(status)}`);
  $('#chargesList').innerHTML = charges.length
    ? charges
        .map(
          (charge) => `
          <article class="action-card">
            <div class="card-head">
              <div><h3>${escapeHtml(charge.customer_name)}</h3><p>${escapeHtml(charge.whatsapp_masked)} · ${escapeHtml(charge.plan_name)}</p></div>
              ${statusTag(charge.status)}
            </div>
            <div class="card-meta">
              <div><span>Estágio</span><strong>${escapeHtml(charge.stage.toUpperCase())}</strong></div>
              <div><span>Vencimento</span><strong>${date(charge.due_on)}</strong></div>
              <div><span>Valor</span><strong>${money(charge.amount_cents)}</strong></div>
            </div>
            <div class="card-body">${escapeHtml(charge.message_text)}</div>
            <div class="card-actions">
              ${charge.status === 'awaiting_approval' ? `<button class="btn btn-danger" data-reject="${charge.id}">Rejeitar</button><button class="btn btn-success" data-approve="${charge.id}">Aprovar e enviar</button>` : ''}
              ${['approved', 'sent'].includes(charge.status) ? `<button class="btn btn-secondary" data-paid="${charge.id}">Confirmar pagamento manual</button>` : ''}
            </div>
          </article>`
        )
        .join('')
    : '<div class="empty">Nenhuma cobrança neste filtro.</div>';
}

async function loadRenewals() {
  const { renewals } = await api('/api/admin/renewals');
  $('#renewalsList').innerHTML = renewals.length
    ? renewals
        .map(
          (renewal) => `
          <article class="action-card">
            <div class="card-head">
              <div><h3>${escapeHtml(renewal.customer_name)}</h3><p>${renewal.operation === 'provision' ? 'Novo cadastro' : 'Renovação'} · ${escapeHtml(renewal.plan_name)} · ${renewal.duration_months} ${renewal.duration_months === 1 ? 'mês' : 'meses'}</p></div>
              ${statusTag(renewal.status)}
            </div>
            <div class="card-meta">
              <div><span>Validade atual</span><strong>${date(renewal.expires_on)}</strong></div>
              <div><span>Lista BitPanel</span><strong>${escapeHtml(renewal.bitpanel_list_id || 'Pendente')}</strong></div>
              <div><span>Tentativas</span><strong>${renewal.attempts}</strong></div>
            </div>
            ${renewal.error ? `<div class="card-body">${escapeHtml(renewal.error)}</div>` : ''}
            <div class="card-actions">
              ${['awaiting_approval', 'manual_review', 'simulated'].includes(renewal.status) ? `<button class="btn btn-success" data-renew="${renewal.id}">${renewal.operation === 'provision' ? 'Aprovar cadastro' : 'Aprovar renovação'}</button>` : ''}
            </div>
          </article>`
        )
        .join('')
    : '<div class="empty">Nenhuma renovação aguardando ação.</div>';
}

async function loadLeads() {
  const { leads } = await api('/api/admin/leads');
  $('#leadsTable').innerHTML = leads.length
    ? leads
        .map(
          (lead) => `
          <tr>
            <td class="client-cell"><strong>${escapeHtml(lead.name || 'Sem nome')}</strong><small>${escapeHtml(lead.whatsapp_masked || 'Sem WhatsApp')}</small></td>
            <td>${escapeHtml(lead.source)}</td>
            <td>${escapeHtml(lead.desired_plan || 'A definir')}</td>
            <td>${statusTag(lead.status)}</td>
            <td>${dateTime(lead.created_at)}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="5"><div class="empty">Nenhum lead captado ainda.</div></td></tr>';
}

async function loadSettings() {
  const result = await api('/api/admin/settings');
  state.settings = result;
  const settings = result.settings;
  $('#globalPause').checked = Boolean(settings.global_pause);
  $('#salesMode').value = settings.sales_mode || 'approval';
  $('#paymentMode').value = settings.payment_mode || 'simulation';
  $('#whatsappMode').value = settings.whatsapp_mode || 'simulation';
  $('#bitpanelMode').value = settings.bitpanel_mode || 'disabled';
  $('#renewalApproval').checked = settings.renewal_requires_approval !== false;
  renderIntegrations('#settingsIntegrations', result.integrations);
  updateSafety(settings.global_pause);
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  button.disabled = true;
  $('#loginError').textContent = '';
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(values) });
    state.user = result.user;
    showApp();
    await navigate('dashboard');
  } catch (error) {
    $('#loginError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#logoutButton').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.go)));
$('#menuButton').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

$('#scanButton').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    const stats = await api('/api/admin/billing/scan', { method: 'POST' });
    toast(`${stats.created} cobrança(s) preparada(s); ${stats.checked} assinatura(s) verificadas.`);
    await loadDashboard();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    event.currentTarget.disabled = false;
  }
});

let searchTimer;
$('#customerSearch').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadCustomers(event.target.value), 250);
});

$('#customersTable').addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit-customer]');
  if (editButton) {
    const customer = state.customers.find((item) => item.id === editButton.dataset.editCustomer);
    if (!customer) return;
    const form = $('#editCustomerForm');
    form.elements.customerId.value = customer.id;
    form.elements.name.value = customer.name || '';
    form.elements.whatsapp.value = customer.whatsapp_e164 || '';
    form.elements.planCode.value = customer.plan_code || 'monthly';
    form.elements.expiresOn.value = customer.expires_on?.slice(0, 10) || '';
    form.elements.status.value = customer.status || 'active';
    form.elements.bitpanelListId.value = customer.bitpanel_list_id || '';
    form.elements.bitpanelReference.value = customer.bitpanel_reference || '';
    form.elements.bitpanelOwner.value = customer.bitpanel_owner || 'Gate One Pro Server';
    form.elements.consentContact.checked = Boolean(customer.consent_contact);
    $('#editCustomerError').textContent = '';
    $('#editCustomerDialog').showModal();
    return;
  }
  const button = event.target.closest('[data-portal]');
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/customers/${button.dataset.portal}/portal-link`, {
      method: 'POST'
    });
    try {
      await navigator.clipboard.writeText(result.portalUrl);
      toast('Link da área do cliente copiado.');
    } catch {
      window.prompt('Copie o link da área do cliente:', result.portalUrl);
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#newCustomerButton').addEventListener('click', () => $('#customerDialog').showModal());
$('#editCustomerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const customerId = data.customerId;
  delete data.customerId;
  data.consentContact = form.elements.consentContact.checked;
  $('#editCustomerError').textContent = '';
  try {
    await api(`/api/admin/customers/${customerId}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
    $('#editCustomerDialog').close();
    toast('Cliente atualizado com sucesso.');
    await loadCustomers($('#customerSearch').value);
  } catch (error) {
    $('#editCustomerError').textContent = error.message;
  }
});
$('#customerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  data.consentContact = form.elements.consentContact.checked;
  $('#customerError').textContent = '';
  try {
    const result = await api('/api/admin/customers', { method: 'POST', body: JSON.stringify(data) });
    $('#customerDialog').close();
    form.reset();
    toast(`Cliente salvo. Link da área do cliente: ${result.portalUrl}`);
    await loadCustomers();
  } catch (error) {
    $('#customerError').textContent = error.message;
  }
});

$('#importButton').addEventListener('click', () => $('#importDialog').showModal());
$('#importSpreadsheetButton').addEventListener('click', () => $('#spreadsheetDialog').showModal());
$('#spreadsheetForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  $('#spreadsheetError').textContent = '';
  button.disabled = true;
  try {
    const result = await api('/api/admin/customers/import-spreadsheet', {
      method: 'POST',
      body: new FormData(form)
    });
    $('#spreadsheetDialog').close();
    form.reset();
    toast(`${result.imported} cliente(s) processado(s); ${result.errors.length} erro(s).`);
    await loadCustomers();
  } catch (error) {
    $('#spreadsheetError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$('#syncBitPanelButton').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api('/api/admin/customers/sync-bitpanel', {
      method: 'POST',
      body: JSON.stringify({})
    });
    toast(`${result.found} lista(s) encontrada(s): ${result.imported} nova(s), ${result.updated} atualizada(s) e ${result.blocked} bloqueada(s).`);
    await loadCustomers();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});
$('#importForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#importError').textContent = '';
  try {
    const customers = JSON.parse($('#importJson').value);
    const result = await api('/api/admin/customers/import', {
      method: 'POST',
      body: JSON.stringify({ customers })
    });
    $('#importDialog').close();
    toast(`${result.imported} cliente(s) importado(s); ${result.errors.length} erro(s).`);
    await loadCustomers();
  } catch (error) {
    $('#importError').textContent = error.message;
  }
});

$('#chargeFilters').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-status]');
  if (!button) return;
  $$('#chargeFilters .pill').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  await loadCharges(button.dataset.status);
});

$('#chargesList').addEventListener('click', async (event) => {
  const approve = event.target.closest('[data-approve]');
  const reject = event.target.closest('[data-reject]');
  const paid = event.target.closest('[data-paid]');
  const button = approve || reject || paid;
  if (!button) return;
  button.disabled = true;
  try {
    if (approve) await api(`/api/admin/charges/${approve.dataset.approve}/approve`, { method: 'POST' });
    if (reject) await api(`/api/admin/charges/${reject.dataset.reject}/reject`, { method: 'POST' });
    if (paid) await api(`/api/admin/charges/${paid.dataset.paid}/mark-paid`, { method: 'POST' });
    toast(approve ? 'Cobrança aprovada e colocada na fila.' : reject ? 'Cobrança rejeitada.' : 'Pagamento confirmado.');
    await loadCharges();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
  }
});

$('#renewalsList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-renew]');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/admin/renewals/${button.dataset.renew}/approve`, { method: 'POST' });
    toast('Renovação aprovada e enviada ao worker.');
    await loadRenewals();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
  }
});

$('#globalPause').addEventListener('change', async (event) => {
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ global_pause: event.target.checked })
    });
    updateSafety(event.target.checked);
    toast(event.target.checked ? 'Todas as automações foram pausadas.' : 'Automações liberadas.');
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, 'error');
  }
});

$('#saveSettings').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        sales_mode: $('#salesMode').value,
        payment_mode: $('#paymentMode').value,
        whatsapp_mode: $('#whatsappMode').value,
        bitpanel_mode: $('#bitpanelMode').value,
        renewal_requires_approval: $('#renewalApproval').checked
      })
    });
    toast('Configurações salvas.');
    await loadSettings();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    event.currentTarget.disabled = false;
  }
});

$$('.integration-form').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      await api(`/api/admin/integrations/${form.dataset.provider}`, {
        method: 'PUT',
        body: JSON.stringify(values)
      });
      $$('input[type="password"]', form).forEach((input) => (input.value = ''));
      toast('Credenciais protegidas e salvas.');
      await loadSettings();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  $('.test-integration', form).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api(`/api/admin/integrations/${form.dataset.provider}/test`, {
        method: 'POST'
      });
      toast(result.message || 'Conexão confirmada.');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
});

api('/api/auth/me')
  .then(({ user }) => {
    state.user = user;
    showApp();
    return navigate('dashboard');
  })
  .catch(showLogin);
