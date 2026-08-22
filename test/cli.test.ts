import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/cli.js';
import { EXIT_OK, EXIT_USAGE, EXIT_ERROR } from '../src/errors.js';
import {
  startFakeGitHub,
  fakeIssue,
  fakePull,
  fakeRepo,
  type RecordedRequest,
  type Route,
} from './fake-github.js';

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  /** Requests the fake server saw, in order. */
  requests: RecordedRequest[];
}

/** Runs the CLI exactly as `bin/ghcli` does, capturing its streams. */
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
      env: options.env ?? {},
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

test('--help lists the commands and exits cleanly', async () => {
  const { code, stdout } = await ghcli(['--help']);
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /repo list/);
  assert.match(stdout, /issue list/);
  assert.match(stdout, /pr list/);
  assert.match(stdout, /GLOBAL FLAGS/);
});

test('--version prints the package version', async () => {
  const { code, stdout } = await ghcli(['--version']);
  assert.equal(code, EXIT_OK);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('no arguments is a usage error, not a crash', async () => {
  const { code, stderr } = await ghcli([]);
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /No command given/);
});

test('subcommand help is reachable and describes its own flags', async () => {
  const { code, stdout } = await ghcli(['issue', 'list', '--help']);
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /--state/);
  assert.match(stdout, /Pull requests are excluded/);
});

test('unknown commands and subcommands list the valid ones', async () => {
  const unknownCommand = await ghcli(['nope']);
  assert.equal(unknownCommand.code, EXIT_USAGE);
  assert.match(unknownCommand.stderr, /Unknown command 'nope'/);
  assert.match(unknownCommand.stderr, /repo, issue, pr/);

  const unknownSubcommand = await ghcli(['repo', 'destroy']);
  assert.equal(unknownSubcommand.code, EXIT_USAGE);
  assert.match(unknownSubcommand.stderr, /Unknown subcommand 'repo destroy'/);
});

test('a flag belonging to another command is rejected by name', async () => {
  const { code, stderr } = await ghcli(['issue', 'list', 'acme/widgets', '--org', 'acme']);
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /'issue list' does not accept --org/);
});

test('unknown flags are a usage error', async () => {
  const { code, stderr } = await ghcli(['pr', 'list', 'acme/widgets', '--bogus']);
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /bogus/);
});

test('--limit and --state are validated before any request is made', async () => {
  const badLimit = await ghcli(['issue', 'list', 'acme/widgets', '--limit', 'many']);
  assert.equal(badLimit.code, EXIT_USAGE);
  assert.match(badLimit.stderr, /--limit must be a whole number/);

  const badState = await ghcli(['pr', 'list', 'acme/widgets', '--state', 'sideways']);
  assert.equal(badState.code, EXIT_USAGE);
  assert.match(badState.stderr, /--state must be one of open, closed, all/);
});

test('a missing repository argument names what was expected', async () => {
  const { code, stderr } = await ghcli(['issue', 'list']);
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /Missing required argument <repository>/);
  assert.match(stderr, /OWNER\/REPO/);
});

test('extra positional arguments are rejected rather than ignored', async () => {
  const { code, stderr } = await ghcli(['pr', 'list', 'acme/widgets', 'extra']);
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /Unexpected argument 'extra'/);
});

test('listing your own repositories without a token explains how to authenticate', async () => {
  const { code, stderr } = await ghcli(['repo', 'list']);
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /requires authentication/);
  assert.match(stderr, /GITHUB_TOKEN/);
});

test('--user and --org together is a usage error', async () => {
  const { code, stderr } = await ghcli(['repo', 'list', '--user', 'octocat', '--org', 'acme']);
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /cannot be combined/);
});

test('repo list --org renders a table', async () => {
  const { code, stdout } = await ghcli(['repo', 'list', '--org', 'acme'], {
    routes: {
      '/orgs/acme/repos': () => ({
        body: [
          fakeRepo({ full_name: 'acme/widgets', stargazers_count: 12, description: 'Widget maker' }),
          fakeRepo({ full_name: 'acme/private-thing', private: true, language: null }),
        ],
      }),
    },
  });
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /^NAME .*VISIBILITY.*STARS.*LANGUAGE.*PUSHED.*DESCRIPTION/m);
  assert.match(stdout, /acme\/widgets .*public .*12 .*TypeScript.*Widget maker/);
  assert.match(stdout, /acme\/private-thing .*private/);
});

test('repo list sends the sort parameter and the requested page size', async () => {
  const { requests } = await ghcli(
    ['repo', 'list', '--user', 'octocat', '--sort', 'updated', '--limit', '5'],
    { routes: { '/users/octocat/repos': () => ({ body: [] }) } },
  );
  assert.equal(requests[0]?.query['sort'], 'updated');
  assert.equal(requests[0]?.query['per_page'], '30');
});

test('issue list excludes pull requests returned by the issues endpoint', async () => {
  const { code, stdout } = await ghcli(['issue', 'list', 'acme/widgets'], {
    routes: {
      '/repos/acme/widgets/issues': () => ({
        body: [
          fakeIssue({ number: 1, title: 'A real issue' }),
          fakeIssue({ number: 2, title: 'Actually a PR', pull_request: { url: 'https://…' } }),
          fakeIssue({ number: 3, title: 'Another real issue', labels: [{ name: 'bug' }] }),
        ],
      }),
    },
  });
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /A real issue/);
  assert.match(stdout, /Another real issue/);
  assert.doesNotMatch(stdout, /Actually a PR/);
  assert.match(stdout, /bug/);
});

test('issue list forwards --state, --label and --assignee', async () => {
  const { requests } = await ghcli(
    ['issue', 'list', 'acme/widgets', '--state', 'all', '--label', 'bug', '--assignee', 'octocat'],
    { routes: { '/repos/acme/widgets/issues': () => ({ body: [] }) } },
  );
  assert.equal(requests[0]?.query['state'], 'all');
  assert.equal(requests[0]?.query['labels'], 'bug');
  assert.equal(requests[0]?.query['assignee'], 'octocat');
});

test('an empty result set writes a notice to stderr and nothing to stdout', async () => {
  const { code, stdout, stderr } = await ghcli(['issue', 'list', 'acme/widgets'], {
    routes: { '/repos/acme/widgets/issues': () => ({ body: [] }) },
  });
  assert.equal(code, EXIT_OK);
  assert.equal(stdout, '');
  assert.match(stderr, /No open issues found in acme\/widgets/);
});

test('pr list marks drafts and merged pull requests', async () => {
  const { code, stdout } = await ghcli(['pr', 'list', 'acme/widgets', '--state', 'all'], {
    routes: {
      '/repos/acme/widgets/pulls': () => ({
        body: [
          fakePull({ number: 1, title: 'Open one' }),
          fakePull({ number: 2, title: 'Draft one', draft: true }),
          fakePull({ number: 3, title: 'Merged one', state: 'closed', merged_at: '2026-08-01T00:00:00Z' }),
        ],
      }),
    },
  });
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /1 +open +Open one/);
  assert.match(stdout, /2 +draft +Draft one/);
  assert.match(stdout, /3 +merged +Merged one/);
});

test('--json prints the raw API payload', async () => {
  const { code, stdout } = await ghcli(['pr', 'list', 'acme/widgets', '--json'], {
    routes: {
      '/repos/acme/widgets/pulls': () => ({ body: [fakePull({ number: 7, title: 'Seven' })] }),
    },
  });
  assert.equal(code, EXIT_OK);
  const parsed = JSON.parse(stdout) as { number: number; title: string }[];
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.number, 7);
  assert.equal(parsed[0]?.title, 'Seven');
});

test('GITHUB_TOKEN is used when --token is absent, and --token wins when both are set', async () => {
  const routes: Record<string, Route> = { '/repos/acme/widgets/pulls': () => ({ body: [] }) };
  const argv = ['pr', 'list', 'acme/widgets'];

  const fromEnv = await ghcli(argv, { routes, env: { GITHUB_TOKEN: 'from-env' } });
  const fromGhEnv = await ghcli(argv, { routes, env: { GH_TOKEN: 'from-gh-env' } });
  const fromFlag = await ghcli([...argv, '--token', 'from-flag'], {
    routes,
    env: { GITHUB_TOKEN: 'from-env' },
  });

  assert.equal(fromEnv.requests[0]?.headers.authorization, 'Bearer from-env');
  assert.equal(fromGhEnv.requests[0]?.headers.authorization, 'Bearer from-gh-env');
  assert.equal(fromFlag.requests[0]?.headers.authorization, 'Bearer from-flag');
});

test('a repository URL is accepted wherever OWNER/REPO is', async () => {
  const { code } = await ghcli(['pr', 'list', 'https://github.com/acme/widgets'], {
    routes: { '/repos/acme/widgets/pulls': () => ({ body: [] }) },
  });
  assert.equal(code, EXIT_OK);
});

test('an API failure exits 1 with a readable message rather than a stack trace', async () => {
  const { code, stderr } = await ghcli(['issue', 'list', 'acme/ghost'], {
    routes: { '/repos/acme/ghost/issues': () => ({ status: 404, body: { message: 'Not Found' } }) },
  });
  assert.equal(code, EXIT_ERROR);
  assert.match(stderr, /error: GitHub API request failed \(HTTP 404\): Not Found/);
  assert.match(stderr, /hint: /);
  assert.doesNotMatch(stderr, /at Object\./);
});

test('flags may appear before the command words', async () => {
  const { code, stdout } = await ghcli(['--json', 'issue', 'list', 'acme/widgets'], {
    routes: { '/repos/acme/widgets/issues': () => ({ body: [fakeIssue({ number: 4 })] }) },
  });
  assert.equal(code, EXIT_OK);
  assert.equal((JSON.parse(stdout) as { number: number }[])[0]?.number, 4);
});
