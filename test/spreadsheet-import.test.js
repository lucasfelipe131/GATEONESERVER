import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parseCustomerSpreadsheet } from '../src/importers/spreadsheet.js';

function workbookBuffer(bookType) {
  const sheet = XLSX.utils.json_to_sheet([
    {
      Nome: 'Cliente Teste',
      WhatsApp: '5555999999999',
      Plano: 'Trimestral',
      Vencimento: '25/08/2026',
      'ID BitPanel': '5308987',
      Login: 'cliente.teste',
      Status: 'Ativo',
      'Autoriza contato': 'Sim'
    }
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Clientes');
  return XLSX.write(workbook, { type: 'buffer', bookType });
}

for (const bookType of ['xlsx', 'xls']) {
  test(`imports ${bookType} customer spreadsheets`, () => {
    const [customer] = parseCustomerSpreadsheet(workbookBuffer(bookType));
    assert.deepEqual(customer, {
      name: 'Cliente Teste',
      whatsapp: '5555999999999',
      plan: 'quarterly',
      expiresOn: '2026-08-25',
      bitpanelListId: '5308987',
      bitpanelReference: 'cliente.teste',
      status: 'active',
      consentContact: true
    });
  });
}

test('requires a phone or BitPanel list ID', () => {
  const sheet = XLSX.utils.json_to_sheet([{ Nome: 'Sem vínculo', Vencimento: '2026-08-25' }]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Clientes');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  assert.throws(() => parseCustomerSpreadsheet(buffer), /WhatsApp ou ID/);
});
