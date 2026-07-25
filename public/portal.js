const token = location.pathname.split('/').filter(Boolean).pop();
const money = (cents) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const date = (value) =>
  value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`)) : '—';

const statusLabels = {
  active: 'Ativo',
  late: 'Em atraso',
  suspended: 'Suspenso',
  cancelled: 'Cancelado'
};

const renewalLabels = {
  awaiting_approval: 'Aguardando aprovação',
  approved: 'Cobrança aprovada',
  sent: 'Pix enviado'
};

function renderRenewalPlans(customer) {
  const container = document.querySelector('#renewalPlans');
  if (customer.pending_renewal) {
    container.innerHTML = `
      <div class="renewal-pending">
        <strong>${renewalLabels[customer.pending_renewal.status] || 'Renovação em andamento'}</strong>
        <span>${customer.pending_renewal.plan_name} · ${money(customer.pending_renewal.amount_cents)}</span>
      </div>`;
    return;
  }
  container.innerHTML = customer.plans
    .map(
      (plan) => `
        <button class="renewal-choice ${plan.code === 'quarterly' ? 'featured' : ''}" data-plan="${plan.code}">
          <span>
            <strong>${plan.name}</strong>
            <small>${plan.description || (plan.duration_months === 1 ? '1 mês' : `${plan.duration_months} meses`)}</small>
          </span>
          <b>${money(plan.price_cents)}</b>
        </button>`
    )
    .join('');
}

async function requestRenewal(planCode, button) {
  const message = document.querySelector('#portalMessage');
  document.querySelectorAll('[data-plan]').forEach((item) => (item.disabled = true));
  message.className = 'portal-message';
  message.textContent = 'Registrando sua solicitação…';
  try {
    const response = await fetch(`/api/portal/${encodeURIComponent(token)}/renewals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planCode })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Não foi possível solicitar a renovação.');
    message.className = 'portal-message success';
    message.textContent = body.message;
    button.classList.add('selected');
    if (!body.checkoutUrl) throw new Error('O Mercado Pago não retornou a tela de pagamento.');
    window.location.assign(body.checkoutUrl);
  } catch (error) {
    message.className = 'portal-message error';
    message.textContent = error.message;
    document.querySelectorAll('[data-plan]').forEach((item) => (item.disabled = false));
  }
}

fetch(`/api/portal/${encodeURIComponent(token)}`)
  .then(async (response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  })
  .then((customer) => {
    document.querySelector('#portalGreeting').textContent = `Olá, ${customer.name.split(/\s+/)[0]}!`;
    document.querySelector('#portalPlan').textContent = customer.plan_name || 'Sem plano ativo';
    document.querySelector('#portalPrice').innerHTML = `${money(customer.price_cents || 0)} <small>por ciclo</small>`;
    document.querySelector('#portalExpiry').textContent = date(customer.expires_on);
    document.querySelector('#portalStatus').textContent = statusLabels[customer.status] || customer.status;
    document.querySelector('#portalPoints').textContent = customer.points;
    renderRenewalPlans(customer);
    document.querySelector('#portalWhatsapp').href =
      (customer.whatsapp_url || 'https://wa.me/') +
      (customer.whatsapp_url?.includes('?') ? '&' : '?') +
      'text=' +
      encodeURIComponent('Olá! Preciso de ajuda com a renovação do Gate One Pro.');
  })
  .catch((error) => {
    document.querySelector('#portalGreeting').textContent = error.message || 'Acesso indisponível';
  });

document.querySelector('#renewalPlans').addEventListener('click', (event) => {
  const button = event.target.closest('[data-plan]');
  if (!button) return;
  requestRenewal(button.dataset.plan, button);
});
