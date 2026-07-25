const params = new URLSearchParams(location.search);
const status = params.get('status') || 'pending';
const charge = params.get('charge') || params.get('external_reference') || '';
const paymentId = params.get('payment_id') || params.get('collection_id') || '';
const approved = status === 'approved';

document.querySelector('#paymentTitle').textContent = approved
  ? 'Pagamento recebido!'
  : status === 'failure'
    ? 'Pagamento não concluído'
    : 'Pagamento em processamento';
document.querySelector('#paymentMessage').textContent = approved
  ? 'O Mercado Pago retornou a aprovação. A confirmação automática será validada pelo sistema.'
  : status === 'failure'
    ? 'Você pode voltar e tentar novamente. Nenhuma renovação será feita sem confirmação.'
    : 'Aguarde a confirmação do Mercado Pago. A renovação ocorrerá somente após a aprovação.';

const receiptText = [
  'Olá! Segue o comprovante do pagamento do Gate One Pro.',
  paymentId ? `Pagamento Mercado Pago: ${paymentId}` : '',
  charge ? `Cobrança Gate One Pro: ${charge}` : ''
].filter(Boolean).join('\n');
document.querySelector('#receiptWhatsapp').href =
  `https://wa.me/5555996111943?text=${encodeURIComponent(receiptText)}`;
