/** Where a command writes its results and its diagnostics. */
export interface IO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const consoleIO: IO = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Cells longer than this are truncated with an ellipsis. */
  maxWidth?: number;
}

/**
 * Flattens a cell to a single printable line.
 *
 * Issue and pull request titles are free-form user input and regularly contain
 * newlines, tabs, and control characters that would otherwise break column
 * alignment or emit terminal escape sequences.
 */
export function sanitizeCell(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
}

export function truncate(value: string, maxWidth: number): string {
  if (maxWidth <= 0 || value.length <= maxWidth) return value;
  if (maxWidth === 1) return value.slice(0, 1);
  return `${value.slice(0, maxWidth - 1)}…`;
}

/** Renders rows as whitespace-aligned columns. Returns '' for an empty set. */
export function renderTable<T>(columns: Column<T>[], rows: T[]): string {
  if (rows.length === 0 || columns.length === 0) return '';

  const cells = rows.map((row) =>
    columns.map((column) => {
      const text = sanitizeCell(column.value(row));
      return column.maxWidth === undefined ? text : truncate(text, column.maxWidth);
    }),
  );

  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );

  const lines = [columns.map((column, index) => column.header.toUpperCase().padEnd(widths[index] ?? 0))];
  for (const row of cells) {
    lines.push(row.map((cell, index) => cell.padEnd(widths[index] ?? 0)));
  }
  // Trailing padding on the last column is invisible but pollutes copy/paste.
  return lines.map((line) => line.join('  ').trimEnd()).join('\n');
}

/** Formats an ISO timestamp as a compact age, e.g. `3d ago`. */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '';

  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return 'just now';

  const units: [limit: number, seconds: number, suffix: string][] = [
    [60, 60, 'm'],
    [24, 3_600, 'h'],
    [30, 86_400, 'd'],
    [12, 2_592_000, 'mo'],
    [Number.POSITIVE_INFINITY, 31_536_000, 'y'],
  ];
  for (const [limit, unitSeconds, suffix] of units) {
    const amount = Math.floor(seconds / unitSeconds);
    if (amount < limit) return `${Math.max(1, amount)}${suffix} ago`;
  }
  return '';
}

export function printJson(value: unknown, write: (text: string) => void): void {
  write(JSON.stringify(value, null, 2));
}

/**
 * Prints a result set as either a table or JSON.
 *
 * `emptyMessage` goes to stderr so that piping table output to another program
 * yields nothing at all when there are no matches.
 */
export function printRows<T>(
  rows: T[],
  columns: Column<T>[],
  options: { json: boolean; emptyMessage: string },
  io: IO,
): void {
  if (options.json) {
    printJson(rows, io.out);
    return;
  }
  if (rows.length === 0) {
    io.err(options.emptyMessage);
    return;
  }
  io.out(renderTable(columns, rows));
}
