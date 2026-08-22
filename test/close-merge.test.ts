import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/cli.js';
import { EXIT_OK, EXIT_USAGE, EXIT_ERROR } from '../src/errors.js';
import { startFakeGitHub, type RecordedRequest, type Route } from './fake-github.js';

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  requests: RecordedRequest[];
}

const TOKEN_ENV = { GITHUB_TOKEN: 'test-token' };

async function ghcli(
  argv: string[],
  options: { routes?: Record<string, Route>; env?: NodeJS.ProcessEnv } = {},
): Promise<Result> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const server = options.routes === undefined ? undefined : await startFakeGitHub(options.routes);
  try {
    const code = await execute({
      argv: server === undefined ? argv : [...argv, '--api-url', server.url],
      env: options.env ?? TOKEN_ENV,
      out: (text) => stdout.push(text),
      err: (text) => stderr.push(text),
    });
    return {
      code,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      requests: server?.requests ?? [],
    };
  } finally {
    await server?.close();
  }
}

/** Just the method and path of each request, for asserting on call order. */
const trace = (requests: RecordedRequest[]): string[] =>
  requests.map((request) => `${request.method} ${request.pathname}`);

const OPEN_ISSUE = {
  number: 12,
  state: 'open',
  title: 'Login times out',
  html_url: 'https://github.com/acme/widgets/issues/12',
};

function issueRoutes(issue: Record<string, unknown> = OPEN_ISSUE): Record<string, Route> {
  return {
    'GET /repos/acme/widgets/issues/12': () => ({ body: issue }),
    'PATCH /repos/acme/widgets/issues/12': ({ body }) => ({
      body: { ...issue, ...(body as object), html_url: OPEN_ISSUE.html_url },
    }),
    'POST /repos/acme/widgets/issues/12/comments': () => ({ status: 201, body: { id: 1 } }),
  };
}

const MERGEABLE_PULL = {
  number: 34,
  state: 'open',
  draft: false,
  merged: false,
  mergeable: true,
  merge_commit_sha: null,
  head: { ref: 'paginate', repo: { full_name: 'acme/widgets' } },
  base: { ref: 'main', repo: { full_name: 'acme/widgets', default_branch: 'main' } },
  html_url: 'https://github.com/acme/widgets/pull/34',
};

const MERGE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function pullRoutes(
  pull: Record<string, unknown> = MERGEABLE_PULL,
  extra: Record<string, Route> = {},
): Record<string, Route> {
  return {
    'GET /repos/acme/widgets/pulls/34': () => ({ body: pull }),
    'PUT /repos/acme/widgets/pulls/34/merge': () => ({
      body: { sha: MERGE_SHA, merged: true, message: 'Pull Request successfully merged' },
    }),
    'DELETE /repos/acme/widgets/git/refs/heads/paginate': () => ({ status: 204 }),
    ...extra,
  };
}

// --- issue close -------------------------------------------------------------

test('issue close patches the issue closed and prints its URL', async () => {
  const { code, stdout, requests } = await ghcli(['issue', 'close', 'acme/widgets', '12'], {
    routes: issueRoutes(),
  });
  assert.equal(code, EXIT_OK);
  assert.equal(stdout, OPEN_ISSUE.html_url);
  assert.deepEqual(trace(requests), [
    'GET /repos/acme/widgets/issues/12',
    'PATCH /repos/acme/widgets/issues/12',
  ]);
  assert.deepEqual(requests[1]?.body, { state: 'closed', state_reason: 'completed' });
});

test('issue close --reason not_planned is forwarded', async () => {
  const { requests } = await ghcli(
    ['issue', 'close', 'acme/widgets', '12', '--reason', 'not_planned'],
    { routes: issueRoutes() },
  );
  assert.equal((requests[1]?.body as { state_reason: string }).state_reason, 'not_planned');
});

test('an unknown --reason is rejected before any request', async () => {
  const { code, stderr, requests } = await ghcli(
    ['issue', 'close', 'acme/widgets', '12', '--reason', 'bored'],
    { routes: issueRoutes() },
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /--reason must be one of completed, not_planned/);
  assert.equal(requests.length, 0);
});

test('issue close --comment posts the comment before closing', async () => {
  const { code, requests } = await ghcli(
    ['issue', 'close', 'acme/widgets', '12', '--comment', 'Fixed in #34.'],
    { routes: issueRoutes() },
  );
  assert.equal(code, EXIT_OK);
  assert.deepEqual(trace(requests), [
    'GET /repos/acme/widgets/issues/12',
    'POST /repos/acme/widgets/issues/12/comments',
    'PATCH /repos/acme/widgets/issues/12',
  ]);
  assert.deepEqual(requests[1]?.body, { body: 'Fixed in #34.' });
});

test('issue close refuses a number that is really a pull request', async () => {
  const { code, stderr, requests } = await ghcli(['issue', 'close', 'acme/widgets', '12'], {
    routes: issueRoutes({ ...OPEN_ISSUE, pull_request: { url: 'https://…' } }),
  });
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /is a pull request, not an issue/);
  assert.deepEqual(trace(requests), ['GET /repos/acme/widgets/issues/12'], 'must not patch');
});

test('closing an already-closed issue writes nothing and says so', async () => {
  const { code, stdout, stderr, requests } = await ghcli(
    ['issue', 'close', 'acme/widgets', '12'],
    { routes: issueRoutes({ ...OPEN_ISSUE, state: 'closed' }) },
  );
  assert.equal(code, EXIT_OK);
  assert.match(stderr, /already closed/);
  assert.equal(stdout, OPEN_ISSUE.html_url);
  assert.deepEqual(trace(requests), ['GET /repos/acme/widgets/issues/12']);
});

test('issue close without a token never reaches the API', async () => {
  const { code, stderr, requests } = await ghcli(['issue', 'close', 'acme/widgets', '12'], {
    routes: issueRoutes(),
    env: {},
  });
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /Closing an issue requires authentication/);
  assert.equal(requests.length, 0);
});

// --- number parsing ----------------------------------------------------------

test('a leading # on the number is accepted', async () => {
  const { code, requests } = await ghcli(['issue', 'close', 'acme/widgets', '#12'], {
    routes: issueRoutes(),
  });
  assert.equal(code, EXIT_OK);
  assert.equal(requests[0]?.pathname, '/repos/acme/widgets/issues/12');
});

test('a non-numeric or missing number is a usage error', async () => {
  const notANumber = await ghcli(['issue', 'close', 'acme/widgets', 'twelve']);
  assert.equal(notANumber.code, EXIT_USAGE);
  assert.match(notANumber.stderr, /not a valid issue or pull request number/);

  const missing = await ghcli(['pr', 'merge', 'acme/widgets']);
  assert.equal(missing.code, EXIT_USAGE);
  assert.match(missing.stderr, /Missing required argument <number>/);

  const negative = await ghcli(['issue', 'close', 'acme/widgets', '-3']);
  assert.equal(negative.code, EXIT_USAGE);
});

// --- pr merge ----------------------------------------------------------------

test('pr merge merges and prints the merge commit SHA', async () => {
  const { code, stdout, requests } = await ghcli(['pr', 'merge', 'acme/widgets', '34'], {
    routes: pullRoutes(),
  });
  assert.equal(code, EXIT_OK);
  assert.equal(stdout, MERGE_SHA);
  assert.deepEqual(trace(requests), [
    'GET /repos/acme/widgets/pulls/34',
    'PUT /repos/acme/widgets/pulls/34/merge',
  ]);
  assert.deepEqual(requests[1]?.body, { merge_method: 'merge' });
});

test('pr merge forwards --method, --subject and --message', async () => {
  const { requests } = await ghcli(
    [
      'pr', 'merge', 'acme/widgets', '34',
      '--method', 'squash',
      '--subject', 'Add pagination (#34)',
      '--message', 'Follows the Link header.',
    ],
    { routes: pullRoutes() },
  );
  assert.deepEqual(requests[1]?.body, {
    merge_method: 'squash',
    commit_title: 'Add pagination (#34)',
    commit_message: 'Follows the Link header.',
  });
});

test('an unknown --method is rejected before any request', async () => {
  const { code, stderr, requests } = await ghcli(
    ['pr', 'merge', 'acme/widgets', '34', '--method', 'blend'],
    { routes: pullRoutes() },
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /--method must be one of merge, squash, rebase/);
  assert.equal(requests.length, 0);
});

test('pr merge refuses a draft by name rather than letting GitHub 405', async () => {
  const { code, stderr, requests } = await ghcli(['pr', 'merge', 'acme/widgets', '34'], {
    routes: pullRoutes({ ...MERGEABLE_PULL, draft: true }),
  });
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /is a draft/);
  assert.match(stderr, /Mark it ready for review/);
  assert.deepEqual(trace(requests), ['GET /repos/acme/widgets/pulls/34']);
});

test('pr merge refuses a closed pull request', async () => {
  const { code, stderr, requests } = await ghcli(['pr', 'merge', 'acme/widgets', '34'], {
    routes: pullRoutes({ ...MERGEABLE_PULL, state: 'closed' }),
  });
  assert.equal(code, EXIT_ERROR);
  assert.match(stderr, /closed without having been merged/);
  assert.deepEqual(trace(requests), ['GET /repos/acme/widgets/pulls/34']);
});

test('pr merge refuses a conflicting branch', async () => {
  const { code, stderr, requests } = await ghcli(['pr', 'merge', 'acme/widgets', '34'], {
    routes: pullRoutes({ ...MERGEABLE_PULL, mergeable: false }),
  });
  assert.equal(code, EXIT_ERROR);
  assert.match(stderr, /has conflicts with its base branch/);
  assert.deepEqual(trace(requests), ['GET /repos/acme/widgets/pulls/34']);
});

test('an unknown mergeability warns but still attempts the merge', async () => {
  const { code, stdout, stderr, requests } = await ghcli(['pr', 'merge', 'acme/widgets', '34'], {
    routes: pullRoutes({ ...MERGEABLE_PULL, mergeable: null }),
  });
  assert.equal(code, EXIT_OK);
  assert.match(stderr, /has not finished checking/);
  assert.equal(stdout, MERGE_SHA);
  assert.equal(trace(requests).length, 2);
});

test('an already-merged pull request writes nothing and prints its merge SHA', async () => {
  const { code, stdout, stderr, requests } = await ghcli(['pr', 'merge', 'acme/widgets', '34'], {
    routes: pullRoutes({ ...MERGEABLE_PULL, merged: true, merge_commit_sha: MERGE_SHA }),
  });
  assert.equal(code, EXIT_OK);
  assert.match(stderr, /already merged/);
  assert.equal(stdout, MERGE_SHA);
  assert.deepEqual(trace(requests), ['GET /repos/acme/widgets/pulls/34']);
});

test('--delete-branch removes the head ref after merging', async () => {
  const { code, requests } = await ghcli(
    ['pr', 'merge', 'acme/widgets', '34', '--delete-branch'],
    { routes: pullRoutes() },
  );
  assert.equal(code, EXIT_OK);
  assert.deepEqual(trace(requests), [
    'GET /repos/acme/widgets/pulls/34',
    'PUT /repos/acme/widgets/pulls/34/merge',
    'DELETE /repos/acme/widgets/git/refs/heads/paginate',
  ]);
});

test("--delete-branch leaves a fork's branch alone", async () => {
  const { code, stdout, stderr, requests } = await ghcli(
    ['pr', 'merge', 'acme/widgets', '34', '--delete-branch'],
    {
      routes: pullRoutes({
        ...MERGEABLE_PULL,
        head: { ref: 'paginate', repo: { full_name: 'octocat/widgets' } },
      }),
    },
  );
  assert.equal(code, EXIT_OK);
  assert.equal(stdout, MERGE_SHA);
  assert.match(stderr, /lives in a fork, so it was left in place/);
  assert.equal(trace(requests).length, 2, 'must not delete a ref in another repository');
});

test('--delete-branch refuses to delete the default branch', async () => {
  const { code, stderr, requests } = await ghcli(
    ['pr', 'merge', 'acme/widgets', '34', '--delete-branch'],
    {
      routes: pullRoutes({
        ...MERGEABLE_PULL,
        head: { ref: 'main', repo: { full_name: 'acme/widgets' } },
        base: { ref: 'release', repo: { full_name: 'acme/widgets', default_branch: 'main' } },
      }),
    },
  );
  assert.equal(code, EXIT_OK);
  assert.match(stderr, /is the default branch, so it was left in place/);
  assert.equal(trace(requests).length, 2);
});

test('a failed branch deletion does not fail the merge', async () => {
  const { code, stdout, stderr } = await ghcli(
    ['pr', 'merge', 'acme/widgets', '34', '--delete-branch'],
    {
      routes: pullRoutes(MERGEABLE_PULL, {
        'DELETE /repos/acme/widgets/git/refs/heads/paginate': () => ({
          status: 422,
          body: { message: 'Reference does not exist' },
        }),
      }),
    },
  );
  assert.equal(code, EXIT_OK, 'the merge succeeded, so the command must succeed');
  assert.equal(stdout, MERGE_SHA);
  assert.match(stderr, /Merged, but deleting 'paginate' failed/);
});

test('pr merge --json prints the merge payload', async () => {
  const { code, stdout } = await ghcli(['pr', 'merge', 'acme/widgets', '34', '--json'], {
    routes: pullRoutes(),
  });
  assert.equal(code, EXIT_OK);
  assert.deepEqual(JSON.parse(stdout), {
    sha: MERGE_SHA,
    merged: true,
    message: 'Pull Request successfully merged',
  });
});

test('close and merge appear in help with their own flags', async () => {
  const root = await ghcli(['--help']);
  assert.match(root.stdout, /issue close/);
  assert.match(root.stdout, /pr merge/);

  const merge = await ghcli(['pr', 'merge', '--help']);
  assert.equal(merge.code, EXIT_OK);
  assert.match(merge.stdout, /--delete-branch/);
  assert.match(merge.stdout, /merge \| squash \| rebase/);

  const close = await ghcli(['issue', 'close', '--help']);
  assert.match(close.stdout, /--reason <reason>/);
});

test('close and merge reject flags belonging to other subcommands', async () => {
  const closeWithMethod = await ghcli(['issue', 'close', 'acme/widgets', '12', '--method', 'squash']);
  assert.equal(closeWithMethod.code, EXIT_USAGE);
  assert.match(closeWithMethod.stderr, /'issue close' does not accept --method/);

  const mergeWithReason = await ghcli(['pr', 'merge', 'acme/widgets', '34', '--reason', 'completed']);
  assert.equal(mergeWithReason.code, EXIT_USAGE);
  assert.match(mergeWithReason.stderr, /'pr merge' does not accept --reason/);
});

test('an extra positional after the number is rejected', async () => {
  const { code, stderr } = await ghcli(['pr', 'merge', 'acme/widgets', '34', 'now']);
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /Unexpected argument 'now'/);
});
