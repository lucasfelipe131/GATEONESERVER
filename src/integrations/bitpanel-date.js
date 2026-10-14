const MONTHS = Object.freeze({
  jan: 1, janeiro: 1, fev: 2, fevereiro: 2, mar: 3, marco: 3,
  abr: 4, abril: 4, mai: 5, maio: 5, jun: 6, junho: 6,
  jul: 7, julho: 7, ago: 8, agosto: 8, set: 9, setembro: 9,
  out: 10, outubro: 10, nov: 11, novembro: 11, dez: 12, dezembro: 12
});

// Provider dates use Brazilian Portuguese and Brasilia's explicit offset.
// Never use Date.parse: ambiguous strings or invalid calendar values must fail closed.
export function parseBitPanelPublishedDate(value) {
  const label = String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  if (!label || label.length > 200) return null;
  const numeric = label.match(/(?:^|[^\d])(\d{2})\/(\d{2})\/(\d{4})(.*)$/);
  const portuguese = numeric ? null : label.match(/(?:^|[^a-z\d])(\d{1,2}) de ([a-z]+)\.? de (\d{4})(.*)$/);
  const match = numeric || portuguese;
  if (!match) return null;
  const day = Number(match[1]);
  const month = numeric ? Number(match[2]) : MONTHS[match[2]];
  const year = Number(match[3]);
  const suffix = match[4];
  const time = suffix.match(/^(?:\s*(?:[,—-]\s*)?(?:as\s+)?(\d{2}):(\d{2}))?$/);
  if (!time || year < 2010 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12 ||
      day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const hour = Number(time[1] || 0), minute = Number(time[2] || 0);
  if (hour > 23 || minute > 59) return null;
  const pad = number => String(number).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-03:00`;
}
