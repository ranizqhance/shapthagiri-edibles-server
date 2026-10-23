/**
 * CSV cells, one way, for every export.
 *
 * Spreadsheets run a cell that starts with = + - or @ as a formula — and some
 * strip a leading tab or carriage return first, so those count too. Exports
 * here carry text that customers and staff typed (names, reasons, notes,
 * audit before/after JSON), and they are opened in Excel or Sheets, so such a
 * cell gets a leading apostrophe and is shown as text.
 *
 * Plain numbers are left alone: a negative quantity is a number, not a
 * formula, and turning it into text would break sums in the sheet.
 */
const NUMBER = /^-?\d+(\.\d+)?$/;

export function defuseFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) && !NUMBER.test(text) ? `'${text}` : text;
}

export function csvCell(v: unknown): string {
  const s =
    v == null ? ""
    : v instanceof Date ? v.toISOString()
    : typeof v === "object" ? JSON.stringify(v)
    : String(v);
  return `"${defuseFormula(s).replace(/"/g, '""')}"`;
}

export const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(",");
