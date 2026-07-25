import XLSX from 'xlsx';

const aliases = {
  name: ['nome', 'cliente', 'nome do cliente'],
  whatsapp: ['whatsapp', 'telefone', 'celular', 'fone'],
  plan: ['plano', 'plan'],
  expiresOn: ['vencimento', 'data de vencimento', 'vence em', 'expireson'],
  bitpanelListId: ['id bitpanel', 'id da lista', 'id lista', 'bitpanellistid', 'id'],
  bitpanelReference: ['login', 'usuario', 'usuário', 'referencia', 'referência', 'bitpanelreference'],
  status: ['status', 'situacao', 'situação'],
  consentContact: ['autoriza contato', 'consentimento', 'consentcontact']
};

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function pick(row, names) {
  const entries = Object.entries(row);
  for (const name of names) {
    const found = entries.find(([key]) => normalizeHeader(key) === normalizeHeader(name));
    if (found && String(found[1] ?? '').trim() !== '') return found[1];
  }
  return undefined;
}

function normalizePlan(value) {
  const plan = normalizeHeader(value);
  if (plan.includes('tri')) return 'quarterly';
  if (plan.includes('semes')) return 'semiannual';
  if (plan.includes('anual')) return 'annual';
  return 'monthly';
}

function normalizeStatus(value) {
  const status = normalizeHeader(value);
  if (status.includes('atras') || status.includes('venc')) return 'late';
  if (status.includes('susp')) return 'suspended';
  if (status.includes('cancel')) return 'cancelled';
  return 'active';
}

function normalizeConsent(value, whatsapp) {
  if (value === undefined || value === '') return Boolean(whatsapp);
  return !['nao', 'não', 'false', '0'].includes(normalizeHeader(value));
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  return text;
}

export function parseCustomerSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('A planilha não possui nenhuma aba.');
  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: '',
    raw: false,
    dateNF: 'yyyy-mm-dd'
  });
  if (!rows.length) throw new Error('A primeira aba da planilha está vazia.');

  return rows.map((row, index) => {
    const whatsapp = pick(row, aliases.whatsapp);
    const bitpanelListId = pick(row, aliases.bitpanelListId);
    const expiresOn = normalizeDate(pick(row, aliases.expiresOn));
    if (!expiresOn) throw new Error(`Linha ${index + 2}: informe o vencimento.`);
    if (!whatsapp && !bitpanelListId) {
      throw new Error(`Linha ${index + 2}: informe WhatsApp ou ID da lista BitPanel.`);
    }
    return {
      name: String(pick(row, aliases.name) || '').trim() || undefined,
      whatsapp: String(whatsapp || '').trim() || undefined,
      plan: normalizePlan(pick(row, aliases.plan)),
      expiresOn,
      bitpanelListId: String(bitpanelListId || '').trim() || undefined,
      bitpanelReference: String(pick(row, aliases.bitpanelReference) || '').trim() || undefined,
      status: normalizeStatus(pick(row, aliases.status)),
      consentContact: normalizeConsent(pick(row, aliases.consentContact), whatsapp)
    };
  });
}
