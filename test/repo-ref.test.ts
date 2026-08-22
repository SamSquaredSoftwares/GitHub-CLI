import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoRef } from '../src/repo-ref.js';
import { UsageError } from '../src/errors.js';

test('parses the canonical owner/repo form', () => {
  assert.deepEqual(parseRepoRef('SamSquaredSoftwares/GitHub-CLI'), {
    owner: 'SamSquaredSoftwares',
    name: 'GitHub-CLI',
  });
});

test('parses browser and git remote URLs', () => {
  const expected = { owner: 'acme', name: 'widgets' };
  assert.deepEqual(parseRepoRef('https://github.com/acme/widgets'), expected);
  assert.deepEqual(parseRepoRef('https://github.com/acme/widgets/'), expected);
  assert.deepEqual(parseRepoRef('https://github.com/acme/widgets.git'), expected);
  assert.deepEqual(parseRepoRef('git@github.com:acme/widgets.git'), expected);
  assert.deepEqual(parseRepoRef('ssh://git@github.com/acme/widgets.git'), expected);
});

test('trims surrounding whitespace', () => {
  assert.deepEqual(parseRepoRef('  acme/widgets  '), { owner: 'acme', name: 'widgets' });
});

test('rejects malformed references', () => {
  for (const input of ['', '   ', 'widgets', 'a/b/c', 'acme/', '/widgets', 'acme/wid gets']) {
    assert.throws(() => parseRepoRef(input), UsageError, `expected '${input}' to be rejected`);
  }
});

test('rejects a deep URL path rather than guessing which segments are the repo', () => {
  assert.throws(() => parseRepoRef('https://github.com/acme/widgets/pull/12'), UsageError);
});
