import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubApiError, parseNextLink, USER_AGENT } from '../src/client.js';
import { CliError } from '../src/errors.js';
import { startFakeGitHub, fakeIssue } from './fake-github.js';

test('parseNextLink picks the next page out of a Link header', () => {
  const header =
    '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
  assert.equal(parseNextLink(header), 'https://api.github.com/x?page=2');
});

test('parseNextLink returns undefined when there is no next page', () => {
  assert.equal(parseNextLink(null), undefined);
  assert.equal(parseNextLink(''), undefined);
  assert.equal(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"'), undefined);
});

test('sends auth, API version and user agent headers', async () => {
  const server = await startFakeGitHub({ '/user/repos': () => ({ body: [] }) });
  try {
    const client = new GitHubClient({ apiUrl: server.url, token: 'secret-token' });
    await client.list('user/repos');

    const request = server.requests[0];
    assert.ok(request);
    assert.equal(request.headers.authorization, 'Bearer secret-token');
    assert.equal(request.headers['x-github-api-version'], '2022-11-28');
    assert.equal(request.headers['user-agent'], USER_AGENT);
    assert.equal(request.headers.accept, 'application/vnd.github+json');
  } finally {
    await server.close();
  }
});

test('omits the Authorization header when there is no token', async () => {
  const server = await startFakeGitHub({ '/user/repos': () => ({ body: [] }) });
  try {
    await new GitHubClient({ apiUrl: server.url }).list('user/repos');
    assert.equal(server.requests[0]?.headers.authorization, undefined);
  } finally {
    await server.close();
  }
});

test('paginate follows Link: rel="next" across pages', async () => {
  const server = await startFakeGitHub({
    '/items': ({ url }) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      if (page >= 3) return { body: [{ id: 5 }] };
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      return { body: [{ id: page * 2 - 1 }, { id: page * 2 }], headers: { link: `<${next}>; rel="next"` } };
    },
  });
  try {
    const client = new GitHubClient({ apiUrl: server.url });
    const ids: number[] = [];
    for await (const item of client.paginate<{ id: number }>('items')) ids.push(item.id);

    assert.deepEqual(ids, [1, 2, 3, 4, 5]);
    assert.equal(server.requests.length, 3);
  } finally {
    await server.close();
  }
});

test('list stops requesting pages once the limit is reached', async () => {
  const server = await startFakeGitHub({
    '/items': ({ url }) => {
      const next = new URL(url);
      next.searchParams.set('page', String(Number(url.searchParams.get('page') ?? '1') + 1));
      return {
        body: [{ id: 1 }, { id: 2 }, { id: 3 }],
        headers: { link: `<${next}>; rel="next"` },
      };
    },
  });
  try {
    const items = await new GitHubClient({ apiUrl: server.url }).list<{ id: number }>('items', {}, 2);
    assert.equal(items.length, 2);
    assert.equal(server.requests.length, 1, 'should not have fetched a second page');
  } finally {
    await server.close();
  }
});

test('list applies the filter before the limit, so skipped items are not counted', async () => {
  const server = await startFakeGitHub({
    '/items': () => ({ body: [{ keep: false }, { keep: true }, { keep: false }, { keep: true }] }),
  });
  try {
    const items = await new GitHubClient({ apiUrl: server.url }).list<{ keep: boolean }>(
      'items',
      {},
      2,
      (item) => item.keep,
    );
    assert.deepEqual(items, [{ keep: true }, { keep: true }]);
  } finally {
    await server.close();
  }
});

test('paginate stops on an empty page even if a next link is advertised', async () => {
  const server = await startFakeGitHub({
    '/items': ({ url }) => ({ body: [], headers: { link: `<${url}>; rel="next"` } }),
  });
  try {
    const items = await new GitHubClient({ apiUrl: server.url }).list('items', {}, 5);
    assert.deepEqual(items, []);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('forwards query parameters and drops undefined ones', async () => {
  const server = await startFakeGitHub({ '/repos/acme/widgets/issues': () => ({ body: [fakeIssue()] }) });
  try {
    await new GitHubClient({ apiUrl: server.url }).list(
      'repos/acme/widgets/issues',
      { state: 'closed', labels: undefined },
      5,
    );
    const query = server.requests[0]?.query ?? {};
    assert.equal(query['state'], 'closed');
    assert.ok(!('labels' in query), 'undefined params must not be sent');
    assert.equal(query['per_page'], '30');
  } finally {
    await server.close();
  }
});

test('a 404 without a token explains that private resources look missing', async () => {
  const server = await startFakeGitHub({
    '/repos/acme/secret/issues': () => ({ status: 404, body: { message: 'Not Found' } }),
  });
  try {
    const client = new GitHubClient({ apiUrl: server.url });
    const error = await client.list('repos/acme/secret/issues').then(
      () => undefined,
      (e: unknown) => e as GitHubApiError,
    );
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.status, 404);
    assert.match(error.message, /HTTP 404/);
    assert.match(error.hint ?? '', /unauthenticated/);
  } finally {
    await server.close();
  }
});

test('an exhausted rate limit reports the reset time and suggests a token', async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const server = await startFakeGitHub({
    '/items': () => ({
      status: 403,
      body: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    }),
  });
  try {
    const error = await new GitHubClient({ apiUrl: server.url }).list('items').then(
      () => undefined,
      (e: unknown) => e as GitHubApiError,
    );
    assert.ok(error instanceof GitHubApiError);
    assert.match(error.message, /rate limit exceeded/i);
    assert.match(error.hint ?? '', /resets at/);
    assert.match(error.hint ?? '', /GITHUB_TOKEN/);
  } finally {
    await server.close();
  }
});

test('a 403 that is not a rate limit keeps the API message', async () => {
  const server = await startFakeGitHub({
    '/items': () => ({
      status: 403,
      body: { message: 'Resource not accessible by personal access token' },
      headers: { 'x-ratelimit-remaining': '58' },
    }),
  });
  try {
    const error = await new GitHubClient({ apiUrl: server.url }).list('items').then(
      () => undefined,
      (e: unknown) => e as GitHubApiError,
    );
    assert.ok(error instanceof GitHubApiError);
    assert.match(error.message, /Resource not accessible/);
    assert.doesNotMatch(error.message, /rate limit/i);
  } finally {
    await server.close();
  }
});

test('an unreachable host produces a readable error, not a raw fetch failure', async () => {
  const client = new GitHubClient({ apiUrl: 'http://127.0.0.1:1/' });
  const error = await client.list('items').then(
    () => undefined,
    (e: unknown) => e as CliError,
  );
  assert.ok(error instanceof CliError);
  assert.match(error.message, /Could not reach 127\.0\.0\.1:1/);
});
