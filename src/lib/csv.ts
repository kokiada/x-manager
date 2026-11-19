/**
 * Minimal CSV parse / serialize (RFC 4180 style).
 *
 * - Parser handles quoted fields, embedded commas / quotes / newlines,
 *   and CRLF or LF line endings. A leading BOM is stripped.
 * - Serializer quotes fields that contain a comma, quote or newline,
 *   doubles embedded quotes, and terminates rows with CRLF.
 *
 * Pure and dependency-free so the template / random-word importers
 * (and their tests) can share it.
 */

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      endRow();
      i++;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing field/row without a final newline.
  if (field !== '' || row.length > 0) endRow();
  // Drop fully-empty trailing rows produced by a final newline.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  const escape = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return rows.map((r) => r.map(escape).join(',')).join('\r\n') + '\r\n';
}

/** Download a text file in the browser (used for CSV export). */
export function downloadTextFile(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
