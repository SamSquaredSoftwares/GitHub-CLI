import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRelativeTime,
  printRows,
  renderTable,
  sanitizeCell,
  truncate,
  type Column,
  type IO,
} from '../src/output.js';

interface Row {
  name: string;
  count: number;
}

const COLUMNS: Column<Row>[] = [
  { header: 'name', value: (r) => r.name },
  { header: 'count', value: (r) => String(r.count) },
];

function captureIO(): IO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (t) => stdout.push(t), err: (t) => stderr.push(t) };
}

test('renderTable aligns columns and upper-cases headers', () => {
  const table = renderTable(COLUMNS, [
    { name: 'alpha', count: 1 },
    { name: 'beta-longer', count: 22 },
  ]);
  assert.equal(
    table,
    ['NAME         COUNT', 'alpha        1', 'beta-longer  22'].join('\n'),
  );
});

test('renderTable emits nothing for an empty result set', () => {
  assert.equal(renderTable(COLUMNS, []), '');
});

test('renderTable leaves no trailing whitespace on any line', () => {
  const table = renderTable(COLUMNS, [{ name: 'a', count: 100 }]);
  for (const line of table.split('\n')) {
    assert.equal(line, line.trimEnd(), `line has trailing whitespace: ${JSON.stringify(line)}`);
  }
});

test('sanitizeCell flattens newlines, tabs and escape sequences', () => {
  assert.equal(sanitizeCell('first\nsecond'), 'first second');
  assert.equal(sanitizeCell('a\tb'), 'a b');
  assert.equal(sanitizeCell('\u001B[31mred\u001B[0m'), '[31mred [0m');
  assert.equal(sanitizeCell('  padded  '), 'padded');
});

test('a title containing a newline cannot break table alignment', () => {
  const table = renderTable(COLUMNS, [{ name: 'evil\ntitle', count: 1 }]);
  assert.equal(table.split('\n').length, 2);
});

test('truncate keeps short values and ellipsises long ones', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('exactly-10', 10), 'exactly-10');
  assert.equal(truncate('this-is-far-too-long', 10), 'this-is-f…');
  assert.equal(truncate('abc', 1), 'a');
  assert.equal(truncate('abc', 0), 'abc');
});

test('formatRelativeTime renders compact ages', () => {
  const now = Date.parse('2026-08-22T12:00:00Z');
  assert.equal(formatRelativeTime('2026-08-22T11:59:30Z', now), 'just now');
  assert.equal(formatRelativeTime('2026-08-22T11:00:00Z', now), '1h ago');
  assert.equal(formatRelativeTime('2026-08-19T12:00:00Z', now), '3d ago');
  assert.equal(formatRelativeTime('2026-05-22T12:00:00Z', now), '3mo ago');
  assert.equal(formatRelativeTime('2024-08-22T12:00:00Z', now), '2y ago');
  assert.equal(formatRelativeTime('2026-08-22T12:30:00Z', now), 'in the future');
});

test('formatRelativeTime tolerates missing and unparseable timestamps', () => {
  assert.equal(formatRelativeTime(null), '');
  assert.equal(formatRelativeTime(undefined), '');
  assert.equal(formatRelativeTime('not-a-date'), '');
});

test('printRows sends the empty-set notice to stderr, keeping stdout pipeable', () => {
  const io = captureIO();
  printRows([], COLUMNS, { json: false, emptyMessage: 'Nothing here.' }, io);
  assert.deepEqual(io.stdout, []);
  assert.deepEqual(io.stderr, ['Nothing here.']);
});

test('printRows --json emits an array even when empty', () => {
  const io = captureIO();
  printRows([], COLUMNS, { json: true, emptyMessage: 'Nothing here.' }, io);
  assert.deepEqual(io.stderr, []);
  assert.deepEqual(JSON.parse(io.stdout.join('\n')), []);
});
