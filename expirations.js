import './app.js';

const expirationState = {
  customers: [],
  period: 'all',
  plan: '',
  status: '',
  sort: 'urgent',
  search: ''
};

const $expiration = (selector, parent = document) => parent.querySelector(selector);
const $$expiration = (selector, parent = document) => [...parent.querySelectorAll(selector)];

function escapeExpirationHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[character]);
}

function normalizedExpirationText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function expirationDateParts(value) {
  const match = String(value ?? '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

function expirationDaysUntil(value) {
  const parts = expirationDateParts(value);
  if (!parts) return null;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const target = Date.UTC(parts.year, parts.month - 1, parts.day);
  return Math.round((target - today) / 86400000);
}

function formatExpirationDate(value) {
  const parts = expirationDateParts(value);
  if (!parts) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12))
  );
}

function expirationDeadline(days) {
  if (days === null) return { label: 'Sem vencimento', className: '' };
  if (days < 0) {
    const overdue = Math.abs(days);
    return {
      label: `Vencido há ${overdue} ${overdue === 1 ? 'dia' : 'dias'}`,
      className: 'red'
    };
  }
  if (days === 0) return { label: 'Vence hoje', className: 'amber' };
  if (days <= 7) return { label: `Faltam ${days} ${days === 1 ? 'dia' : 'dias'}`, className: 'amber' };
  if (days <= 30) return { label: `Faltam ${days} dias`, className: 'blue' };
  return { label: `Faltam ${days} dias`, className: 'green' };
}

function expirationStatusTag(status) {
  const statuses = {
    active: ['Ativo', 'green'],
    late: ['Atrasado', 'amber'],
    suspended: ['Suspenso', 'red'],
    cancelled: ['Cancelado', 'red']
  };
  const [label, className] = statuses[status] || [status || 'Sem status', ''];
  return `<span class="tag ${className}">${escapeExpirationHtml(label)}</span>`;
}

function createExpirationPage() {
  const customersNav = $expiration('.nav-item[data-page="customers"]');
  const customersPage = $expiration('.page[data-page-panel="customers"]');
  if (!customersNav || !customersPage || $expiration('.nav-item[data-page="expirations"]')) return;

  const navButton = document.createElement('button');
  navButton.className = 'nav-item';
  navButton.dataset.page = 'expirations';
  navButton.innerHTML = '<span>◷</span> Vencimentos';
  customersNav.after(navButton);

  const page = document.createElement('section');
  page.className = 'page expiration-page';
  page.dataset.pagePanel = 'expirations';
  page.innerHTML = `
    <div class="expiration-heading">
      <div>
        <span class="eyebrow">ORGANIZAÇÃO DE ASSINATURAS</span>
        <h2>Vencimentos dos clientes</h2>
        <p>Priorize clientes vencidos e acompanhe quem precisa de contato nos próximos dias.</p>
      </div>
      <button class="btn btn-secondary" id="expirationRefresh" type="button">↻ Atualizar lista</button>
    </div>

    <div class="metrics expiration-metrics" id="expirationMetrics"></div>

    <article class="panel expiration-panel">
      <div class="expiration-controls">
        <div class="search expiration-search">
          <span>⌕</span>
          <input id="expirationSearch" placeholder="Buscar cliente, WhatsApp, login ou lista" />
        </div>
        <div class="expiration-selects">
          <label>Plano<select id="expirationPlan"><option value="">Todos os planos</option></select></label>
          <label>Status<select id="expirationStatus"><option value="">Todos os status</option></select></label>
          <label>Ordenar<select id="expirationSort"><option value="urgent">Mais urgente</option><option value="distant">Mais distante</option><option value="name">Nome do cliente</option></select></label>
        </div>
      </div>

      <div class="filter-pills expiration-periods" id="expirationPeriods">
        <button class="pill active" type="button" data-expiration-period="all">Todos</button>
        <button class="pill" type="button" data-expiration-period="overdue">Vencidos</button>
        <button class="pill" type="button" data-expiration-period="today">Hoje</button>
        <button class="pill" type="button" data-expiration-period="7">Próximos 7 dias</button>
        <button class="pill" type="button" data-expiration-period="30">Próximos 30 dias</button>
      </div>

      <div class="expiration-result-line" id="expirationResultLine">Carregando vencimentos...</div>
      <div class="table-wrap expiration-table-wrap">
        <table class="expiration-table">
          <thead>
            <tr><th>Cliente</th><th>Plano</th><th>Vencimento</th><th>Prazo</th><th>Status</th><th>BitPanel</th><th>Ação</th></tr>
          </thead>
          <tbody id="expirationTable"></tbody>
        </table>
      </div>
    </article>`;
  customersPage.after(page);

  navButton.addEventListener('click', async () => {
    $$expiration('.nav-item').forEach((button) => button.classList.toggle('active', button === navButton));
    $$expiration('.page').forEach((panel) => panel.classList.toggle('active', panel === page));
    $expiration('#pageEyebrow').textContent = 'CONTROLE DE VALIDADES';
    $expiration('#pageTitle').textContent = 'Vencimentos';
    $expiration('#sidebar').classList.remove('open');
    await loadExpirations();
  });

  $expiration('#expirationRefresh').addEventListener('click', loadExpirations);
  $expiration('#expirationSearch').addEventListener('input', (event) => {
    expirationState.search = event.target.value;
    renderExpirations();
  });
  $expiration('#expirationPlan').addEventListener('change', (event) => {
    expirationState.plan = event.target.value;
    renderExpirations();
  });
  $expiration('#expirationStatus').addEventListener('change', (event) => {
    expirationState.status = event.target.value;
    renderExpirations();
  });
  $expiration('#expirationSort').addEventListener('change', (event) => {
    expirationState.sort = event.target.value;
    renderExpirations();
  });
  $expiration('#expirationPeriods').addEventListener('click', (event) => {
    const button = event.target.closest('[data-expiration-period]');
    if (!button) return;
    expirationState.period = button.dataset.expirationPeriod;
    $$expiration('[data-expiration-period]').forEach((item) => item.classList.toggle('active', item === button));
    renderExpirations();
  });
  $expiration('#expirationTable').addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-expiration-customer]');
    if (!button) return;
    const customersButton = $expiration('.nav-item[data-page="customers"]');
    customersButton?.click();
    window.setTimeout(() => {
      const search = $expiration('#customerSearch');
      if (!search) return;
      search.value = button.dataset.openExpirationCustomer;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.focus();
    }, 180);
  });
}

async function loadExpirations() {
  const refresh = $expiration('#expirationRefresh');
  const table = $expiration('#expirationTable');
  if (!refresh || !table) return;
  refresh.disabled = true;
  table.innerHTML = '<tr><td colspan="7"><div class="empty">Carregando vencimentos...</div></td></tr>';
  try {
    const response = await fetch('/api/admin/customers?search=', { credentials: 'same-origin' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || 'Não foi possível carregar os clientes.');
    expirationState.customers = Array.isArray(body.customers) ? body.customers : [];
    updateExpirationSelects();
    renderExpirations();
  } catch (error) {
    table.innerHTML = `<tr><td colspan="7"><div class="empty">${escapeExpirationHtml(error.message)}</div></td></tr>`;
    $expiration('#expirationResultLine').textContent = 'Falha ao carregar os vencimentos.';
  } finally {
    refresh.disabled = false;
  }
}

function updateExpirationSelects() {
  const planSelect = $expiration('#expirationPlan');
  const statusSelect = $expiration('#expirationStatus');
  const plans = new Map();
  const statuses = new Set();

  expirationState.customers.forEach((customer) => {
    const value = String(customer.plan_code || customer.plan_name || '').trim();
    const label = String(customer.plan_name || customer.plan_code || '').trim();
    if (value) plans.set(value, label || value);
    if (customer.status) statuses.add(customer.status);
  });

  planSelect.innerHTML = '<option value="">Todos os planos</option>' + [...plans.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'))
    .map(([value, label]) => `<option value="${escapeExpirationHtml(value)}">${escapeExpirationHtml(label)}</option>`)
    .join('');
  planSelect.value = plans.has(expirationState.plan) ? expirationState.plan : '';
  if (!planSelect.value) expirationState.plan = '';

  const statusLabels = {
    active: 'Ativo',
    late: 'Atrasado',
    suspended: 'Suspenso',
    cancelled: 'Cancelado'
  };
  statusSelect.innerHTML = '<option value="">Todos os status</option>' + [...statuses]
    .sort((a, b) => (statusLabels[a] || a).localeCompare(statusLabels[b] || b, 'pt-BR'))
    .map((status) => `<option value="${escapeExpirationHtml(status)}">${escapeExpirationHtml(statusLabels[status] || status)}</option>`)
    .join('');
  statusSelect.value = statuses.has(expirationState.status) ? expirationState.status : '';
  if (!statusSelect.value) expirationState.status = '';
}

function expirationMatchesPeriod(days) {
  if (expirationState.period === 'overdue') return days !== null && days < 0;
  if (expirationState.period === 'today') return days === 0;
  if (expirationState.period === '7') return days !== null && days >= 0 && days <= 7;
  if (expirationState.period === '30') return days !== null && days >= 0 && days <= 30;
  return true;
}

function filteredExpirationCustomers() {
  const search = normalizedExpirationText(expirationState.search);
  const result = expirationState.customers.filter((customer) => {
    const days = expirationDaysUntil(customer.expires_on);
    const planValue = String(customer.plan_code || customer.plan_name || '');
    const haystack = normalizedExpirationText([
      customer.name,
      customer.whatsapp_masked,
      customer.whatsapp_e164,
      customer.bitpanel_reference,
      customer.bitpanel_list_id
    ].filter(Boolean).join(' '));

    return (!search || haystack.includes(search))
      && (!expirationState.plan || planValue === expirationState.plan)
      && (!expirationState.status || customer.status === expirationState.status)
      && expirationMatchesPeriod(days);
  });

  return result.sort((a, b) => {
    if (expirationState.sort === 'name') {
      return String(a.name || a.bitpanel_reference || '').localeCompare(String(b.name || b.bitpanel_reference || ''), 'pt-BR');
    }
    const aDays = expirationDaysUntil(a.expires_on);
    const bDays = expirationDaysUntil(b.expires_on);
    if (aDays === null && bDays === null) return 0;
    if (aDays === null) return 1;
    if (bDays === null) return -1;
    return expirationState.sort === 'distant' ? bDays - aDays : aDays - bDays;
  });
}

function renderExpirationMetrics(filteredTotal) {
  const totals = expirationState.customers.reduce((summary, customer) => {
    const days = expirationDaysUntil(customer.expires_on);
    if (days !== null && days < 0) summary.overdue += 1;
    if (days === 0) summary.today += 1;
    if (days !== null && days >= 0 && days <= 7) summary.next7 += 1;
    if (days !== null && days >= 0 && days <= 30) summary.next30 += 1;
    return summary;
  }, { overdue: 0, today: 0, next7: 0, next30: 0 });

  const items = [
    ['Vencidos', totals.overdue, '!', 'exigem atenção imediata', 'danger'],
    ['Vencem hoje', totals.today, '◷', 'contato prioritário', 'warning'],
    ['Até 7 dias', totals.next7, '7', 'inclui os de hoje', 'primary'],
    ['Até 30 dias', totals.next30, '30', 'planejamento de contato', 'calm'],
    ['Exibidos', filteredTotal, '◎', 'resultado dos filtros', 'neutral']
  ];

  $expiration('#expirationMetrics').innerHTML = items.map(([label, value, icon, note, tone]) => `
    <article class="metric expiration-metric ${tone}">
      <div class="metric-top"><span>${label}</span><span class="metric-icon">${icon}</span></div>
      <strong>${value}</strong><small>${note}</small>
    </article>`).join('');
}

function renderExpirations() {
  const customers = filteredExpirationCustomers();
  renderExpirationMetrics(customers.length);
  $expiration('#expirationResultLine').textContent = `${customers.length} de ${expirationState.customers.length} cliente(s) exibido(s).`;
  const table = $expiration('#expirationTable');

  table.innerHTML = customers.length
    ? customers.map((customer) => {
      const days = expirationDaysUntil(customer.expires_on);
      const deadline = expirationDeadline(days);
      const customerName = customer.name || customer.bitpanel_reference || 'A preencher';
      const reference = customer.bitpanel_reference || customer.bitpanel_list_id || 'Não vinculado';
      return `
        <tr class="expiration-row ${days !== null && days < 0 ? 'is-overdue' : days === 0 ? 'is-today' : ''}">
          <td data-label="Cliente" class="client-cell"><strong>${escapeExpirationHtml(customerName)}</strong><small>${escapeExpirationHtml(customer.whatsapp_masked || 'Telefone a preencher')}</small></td>
          <td data-label="Plano">${escapeExpirationHtml(customer.plan_name || customer.plan_code || 'Sem plano')}</td>
          <td data-label="Vencimento"><strong>${formatExpirationDate(customer.expires_on)}</strong></td>
          <td data-label="Prazo"><span class="tag ${deadline.className}">${escapeExpirationHtml(deadline.label)}</span></td>
          <td data-label="Status">${expirationStatusTag(customer.status)}</td>
          <td data-label="BitPanel"><span class="expiration-reference">${escapeExpirationHtml(reference)}</span></td>
          <td data-label="Ação"><button class="btn btn-secondary btn-small" type="button" data-open-expiration-customer="${escapeExpirationHtml(customerName)}">Ver cliente</button></td>
        </tr>`;
    }).join('')
    : '<tr><td colspan="7"><div class="empty">Nenhum cliente encontrado para estes filtros.</div></td></tr>';
}

createExpirationPage();
