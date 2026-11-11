// Minimal RFC 4180 CSV reader/writer (quotes, embedded commas/newlines, BOM, CRLF).
export function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (q) throw new Error('CSV has an unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

/** Parse into objects keyed by header. Duplicate/blank headers are rejected. */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const seen = new Set();
  for (const h of headers) { if (!h) throw new Error('CSV has an empty column header'); if (seen.has(h.toLowerCase())) throw new Error(`CSV has a duplicate column "${h}"`); seen.add(h.toLowerCase()); }
  const records = rows.slice(1).map((r, i) => ({ _row: i + 2, ...Object.fromEntries(headers.map((h, j) => [h, (r[j] ?? '').trim()])) }));
  return { headers, records };
}

// Cells starting with = + - @ are prefixed so spreadsheets do not run them as formulas.
const cell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (headers, records) => [headers.map(cell).join(','), ...records.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\r\n') + '\r\n';
