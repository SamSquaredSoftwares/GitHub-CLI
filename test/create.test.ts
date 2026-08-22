import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  options: {
    routes?: Record<string, Route>;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
  } = {},
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
      readStdin: options.stdin === undefined ? undefined : async () => options.stdin as string,
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

const CREATED_ISSUE = { number: 12, html_url: 'https://github.com/acme/widgets/issues/12' };
const CREATED_PULL = { number: 34, html_url: 'https://github.com/acme/widgets/pull/34' };

const issueRoutes: Record<string, Route> = {
  'POST /repos/acme/widgets/issues': () => ({ status: 201, body: CREATED_ISSUE }),
};
const pullRoutes: Record<string, Route> = {
  'GET /repos/acme/widgets': () => ({ body: { default_branch: 'trunk' } }),
  'POST /repos/acme/widgets/pulls': () => ({ status: 201, body: CREATED_PULL }),
};

test('issue create posts the title and prints the new issue URL', async () => {
  const { code, stdout, requests } = await ghcli(
    ['issue', 'create', 'acme/widgets', '--title', 'Something is broken'],
    { routes: issueRoutes },
  );
  assert.equal(code, EXIT_OK);
  assert.equal(stdout, CREATED_ISSUE.html_url);

  const request = requests[0];
  assert.equal(request?.method, 'POST');
  assert.equal(request?.pathname, '/repos/acme/widgets/issues');
  assert.equal(request?.headers['content-type'], 'application/json');
  assert.equal(request?.headers.authorization, 'Bearer test-token');
  assert.deepEqual(request?.body, { title: 'Something is broken' });
});

test('issue create omits body, labels and assignees when they were not given', async () => {
  const { requests } = await ghcli(['issue', 'create', 'acme/widgets', '--title', 'Bare'], {
    routes: issueRoutes,
  });
  assert.deepEqual(Object.keys(requests[0]?.body as object), ['title']);
});

test('issue create sends labels and assignees, repeated or comma-separated', async () => {
  const { requests } = await ghcli(
    [
      'issue', 'create', 'acme/widgets',
      '--title', 'Tagged',
      '--label', 'bug',
      '--label', 'urgent,triage',
      '--assignee', 'octocat',
      '--assignee', 'mona',
    ],
    { routes: issueRoutes },
  );
  assert.deepEqual(requests[0]?.body, {
    title: 'Tagged',
    labels: ['bug', 'urgent', 'triage'],
    assignees: ['octocat', 'mona'],
  });
});

test('issue create --json prints the created payload', async () => {
  const { code, stdout } = await ghcli(
    ['issue', 'create', 'acme/widgets', '--title', 'JSON', '--json'],
    { routes: issueRoutes },
  );
  assert.equal(code, EXIT_OK);
  assert.deepEqual(JSON.parse(stdout), CREATED_ISSUE);
});

test('issue create requires --title', async () => {
  const { code, stderr, requests } = await ghcli(['issue', 'create', 'acme/widgets'], {
    routes: issueRoutes,
  });
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /Missing required flag --title/);
  assert.equal(requests.length, 0, 'must not reach the API');
});

test('a create without a token fails before any request, naming the fix', async () => {
  const { code, stderr, requests } = await ghcli(
    ['issue', 'create', 'acme/widgets', '--title', 'No auth'],
    { routes: issueRoutes, env: {} },
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /Creating an issue requires authentication/);
  assert.match(stderr, /GITHUB_TOKEN/);
  assert.equal(requests.length, 0, 'must not reach the API');
});

test('issue create rejects flags that belong to issue list', async () => {
  const { code, stderr } = await ghcli(
    ['issue', 'create', 'acme/widgets', '--title', 'x', '--state', 'open'],
    { routes: issueRoutes },
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /'issue create' does not accept --state/);
});

test('--body-file reads the body from a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghcli-'));
  const path = join(dir, 'body.md');
  await writeFile(path, '## Steps\n\n1. Do the thing\n');

  const { code, requests } = await ghcli(
    ['issue', 'create', 'acme/widgets', '--title', 'From file', '--body-file', path],
    { routes: issueRoutes },
  );
  assert.equal(code, EXIT_OK);
  assert.equal((requests[0]?.body as { body: string }).body, '## Steps\n\n1. Do the thing\n');
});

test("--body-file '-' reads the body from stdin", async () => {
  const { code, requests } = await ghcli(
    ['issue', 'create', 'acme/widgets', '--title', 'Piped', '--body-file', '-'],
    { routes: issueRoutes, stdin: 'body from a pipe' },
  );
  assert.equal(code, EXIT_OK);
  assert.equal((requests[0]?.body as { body: string }).body, 'body from a pipe');
});

test('--body and --body-file together is a usage error', async () => {
  const { code, stderr } = await ghcli(
    ['issue', 'create', 'acme/widgets', '--title', 'x', '--body', 'a', '--body-file', '-'],
    { routes: issueRoutes },
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /--body and --body-file cannot be combined/);
});

test('an unreadable --body-file is reported as such, not as a crash', async () => {
  const { code, stderr } = await ghcli(
    ['issue', 'create', 'acme/widgets', '--title', 'x', '--body-file', '/no/such/file.md'],
    { routes: issueRoutes },
  );
  assert.equal(code, EXIT_ERROR);
  assert.match(stderr, /Could not read --body-file/);
  assert.doesNotMatch(stderr, /at Object\./);
});

test('pr create defaults --base to the repository default branch', async () => {
  const { code, stdout, requests } = await ghcli(
    ['pr', 'create', 'acme/widgets', '--title', 'Add a thing', '--head', 'feature'],
    { routes: pullRoutes },
  );
  assert.equal(code, EXIT_OK);
  assert.equal(stdout, CREATED_PULL.html_url);

  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.pathname, '/repos/acme/widgets');
  assert.deepEqual(requests[1]?.body, {
    title: 'Add a thing',
    head: 'feature',
    base: 'trunk',
    draft: false,
  });
});

test('an explicit --base skips the default-branch lookup', async () => {
  const { requests } = await ghcli(
    ['pr', 'create', 'acme/widgets', '--title', 'x', '--head', 'feature', '--base', 'release'],
    { routes: pullRoutes },
  );
  assert.equal(requests.length, 1, 'should not have fetched the repository');
  assert.equal((requests[0]?.body as { base: string }).base, 'release');
});

test('pr create --draft opens a draft', async () => {
  const { requests } = await ghcli(
    ['pr', 'create', 'acme/widgets', '--title', 'x', '--head', 'f', '--base', 'main', '--draft'],
    { routes: pullRoutes },
  );
  assert.equal((requests[0]?.body as { draft: boolean }).draft, true);
});

test('pr create requires --head', async () => {
  const { code, stderr, requests } = await ghcli(
    ['pr', 'create', 'acme/widgets', '--title', 'x', '--base', 'main'],
    { routes: pullRoutes },
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /Missing required flag --head/);
  assert.equal(requests.length, 0);
});

test('pr create refuses a head that equals the base', async () => {
  const { code, stderr } = await ghcli(
    ['pr', 'create', 'acme/widgets', '--title', 'x', '--head', 'main', '--base', 'main'],
    { routes: pullRoutes },
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /a pull request needs two different branches/);
});

test('a 422 reports which field GitHub rejected', async () => {
  const { code, stderr } = await ghcli(
    ['pr', 'create', 'acme/widgets', '--title', 'x', '--head', 'gone', '--base', 'main'],
    {
      routes: {
        'POST /repos/acme/widgets/pulls': () => ({
          status: 422,
          body: {
            message: 'Validation Failed',
            errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
          },
        }),
      },
    },
  );
  assert.equal(code, EXIT_ERROR);
  assert.match(stderr, /Validation Failed \(head: invalid\)/);
});

test('a 403 on a write explains that the token lacks permission', async () => {
  const { code, stderr } = await ghcli(
    ['issue', 'create', 'acme/widgets', '--title', 'x'],
    {
      routes: {
        'POST /repos/acme/widgets/issues': () => ({
          status: 403,
          body: { message: 'Resource not accessible by personal access token' },
          headers: { 'x-ratelimit-remaining': '4999' },
        }),
      },
    },
  );
  assert.equal(code, EXIT_ERROR);
  assert.match(stderr, /lacks permission/);
  assert.doesNotMatch(stderr, /rate limit/i);
});

test('issue list ANDs repeated --label values into one filter', async () => {
  const { requests } = await ghcli(
    ['issue', 'list', 'acme/widgets', '--label', 'bug', '--label', 'urgent'],
    { routes: { '/repos/acme/widgets/issues': () => ({ body: [] }) } },
  );
  assert.equal(requests[0]?.query['labels'], 'bug,urgent');
});

test('issue list rejects more than one --assignee, which the API cannot express', async () => {
  const { code, stderr } = await ghcli(
    ['issue', 'list', 'acme/widgets', '--assignee', 'octocat', '--assignee', 'mona'],
    { routes: { '/repos/acme/widgets/issues': () => ({ body: [] }) } },
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /--assignee may only be given once/);
});

test('create subcommands appear in help', async () => {
  const root = await ghcli(['--help']);
  assert.match(root.stdout, /issue create/);
  assert.match(root.stdout, /pr create/);

  const prCreate = await ghcli(['pr', 'create', '--help']);
  assert.equal(prCreate.code, EXIT_OK);
  assert.match(prCreate.stdout, /--head <branch>/);
  assert.match(prCreate.stdout, /--draft/);
});
