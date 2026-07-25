const token = location.pathname.split('/').filter(Boolean).pop();
const money = (cents) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const date = (value) =>
  value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`)) : '—';

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
    document.querySelector('#portalStatus').textContent = customer.status;
    document.querySelector('#portalPoints').textContent = customer.points;
    document.querySelector('#portalWhatsapp').href =
      (customer.whatsapp_url || 'https://wa.me/') +
      (customer.whatsapp_url?.includes('?') ? '&' : '?') +
      'text=' +
      encodeURIComponent('Olá! Quero renovar meu Gate One Pro.');
  })
  .catch((error) => {
    document.querySelector('#portalGreeting').textContent = error.message || 'Acesso indisponível';
  });
