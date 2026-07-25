document.querySelectorAll('.choose-plan').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('[name="desiredPlan"]').value = button.dataset.plan;
    document.querySelector('#quero').scrollIntoView({ behavior: 'smooth' });
  });
});

document.querySelector('#leadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const message = document.querySelector('#leadMessage');
  const data = Object.fromEntries(new FormData(form));
  data.consent = form.elements.consent.checked;
  button.disabled = true;
  message.textContent = '';
  try {
    const response = await fetch('/api/public/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    message.style.color = '#10a36a';
    message.textContent = body.message;
    if (!body.checkoutUrl) throw new Error('O Mercado Pago não retornou a tela de pagamento.');
    window.location.assign(body.checkoutUrl);
  } catch (error) {
    message.style.color = '#df4b55';
    message.textContent = error.message || 'Não foi possível enviar.';
  } finally {
    button.disabled = false;
  }
});
