import { parseArgs } from 'node:util';
import { GitHubClient, DEFAULT_API_URL } from './client.js';
import { CliError, UsageError, EXIT_OK } from './errors.js';
import { consoleIO, type IO } from './output.js';
import { parseRepoRef } from './repo-ref.js';
import { repoList } from './commands/repo.js';
import { issueList, issueCreate } from './commands/issue.js';
import { prList, prCreate } from './commands/pr.js';
import { resolveBody, readProcessStdin, type StdinReader } from './body.js';

export const BIN = 'ghcli';

/**
 * Every option the CLI understands.
 *
 * The whole set is parsed in one pass so that flags may appear before or after
 * the command words; `COMMANDS` then rejects flags that the chosen command
 * does not accept.
 */
const OPTIONS = {
  token: { type: 'string' },
  'api-url': { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
  user: { type: 'string' },
  org: { type: 'string' },
  limit: { type: 'string' },
  sort: { type: 'string' },
  state: { type: 'string' },
  label: { type: 'string', multiple: true },
  assignee: { type: 'string', multiple: true },
  base: { type: 'string' },
  title: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  head: { type: 'string' },
  draft: { type: 'boolean', default: false },
} as const;

type OptionName = keyof typeof OPTIONS;

const GLOBAL_OPTIONS: OptionName[] = ['token', 'api-url', 'json', 'help', 'version'];

interface CommandSpec {
  /** Positional arguments after the command words, for usage strings. */
  args: string;
  summary: string;
  options: OptionName[];
  help: string;
}

const REPO_ARG_HINT = "OWNER/REPO, for example 'SamSquaredSoftwares/GitHub-CLI'";

const COMMANDS: Record<string, Record<string, CommandSpec>> = {
  repo: {
    list: {
      args: '',
      summary: 'List repositories for a user, an organization, or yourself',
      options: ['user', 'org', 'limit', 'sort'],
      help: `List repositories.

USAGE
  ${BIN} repo list [flags]

FLAGS
  --user <login>    List repositories owned by this user
  --org <org>       List repositories owned by this organization
  --limit <n>       Maximum repositories to show (default: 30)
  --sort <field>    created | updated | pushed | full_name (default: pushed)

With neither --user nor --org, lists the authenticated user's repositories,
which requires a token.`,
    },
  },
  issue: {
    list: {
      args: '<repository>',
      summary: 'List issues in a repository',
      options: ['state', 'label', 'assignee', 'limit'],
      help: `List issues in a repository.

USAGE
  ${BIN} issue list <repository> [flags]

ARGUMENTS
  <repository>      ${REPO_ARG_HINT}

FLAGS
  --state <state>   open | closed | all (default: open)
  --label <name>    Only issues carrying this label
  --assignee <login>  Only issues assigned to this user
  --limit <n>       Maximum issues to show (default: 30)

Pull requests are excluded, even though the underlying API returns them.`,
    },
    create: {
      args: '<repository>',
      summary: 'Open an issue in a repository',
      options: ['title', 'body', 'body-file', 'label', 'assignee'],
      help: `Open an issue in a repository.

USAGE
  ${BIN} issue create <repository> --title <title> [flags]

ARGUMENTS
  <repository>      ${REPO_ARG_HINT}

FLAGS
  --title <title>   Issue title (required)
  --body <text>     Issue body
  --body-file <path>  Read the body from a file, or '-' for stdin
  --label <name>    Label to apply; repeat or comma-separate for several
  --assignee <login>  User to assign; repeat or comma-separate for several

Prints the URL of the new issue, or the full API payload with --json.
Requires a token with write access to the repository.`,
    },
  },
  pr: {
    list: {
      args: '<repository>',
      summary: 'List pull requests in a repository',
      options: ['state', 'base', 'limit'],
      help: `List pull requests in a repository.

USAGE
  ${BIN} pr list <repository> [flags]

ARGUMENTS
  <repository>      ${REPO_ARG_HINT}

FLAGS
  --state <state>   open | closed | all (default: open)
  --base <branch>   Only pull requests targeting this branch
  --limit <n>       Maximum pull requests to show (default: 30)`,
    },
    create: {
      args: '<repository>',
      summary: 'Open a pull request in a repository',
      options: ['title', 'body', 'body-file', 'head', 'base', 'draft'],
      help: `Open a pull request in a repository.

USAGE
  ${BIN} pr create <repository> --title <title> --head <branch> [flags]

ARGUMENTS
  <repository>      ${REPO_ARG_HINT}

FLAGS
  --title <title>   Pull request title (required)
  --head <branch>   Branch containing the changes (required); OWNER:BRANCH for a fork
  --base <branch>   Branch to merge into (default: the repository's default branch)
  --body <text>     Pull request body
  --body-file <path>  Read the body from a file, or '-' for stdin
  --draft           Open as a draft

Prints the URL of the new pull request, or the full API payload with --json.
Requires a token with write access to the repository.`,
    },
  },
};

const STATES = ['open', 'closed', 'all'];
const REPO_SORTS = ['created', 'updated', 'pushed', 'full_name'];

function rootHelp(): string {
  const rows: string[] = [];
  for (const [group, subcommands] of Object.entries(COMMANDS)) {
    for (const [name, spec] of Object.entries(subcommands)) {
      rows.push(`  ${`${group} ${name}`.padEnd(14)}${spec.summary}`);
    }
  }
  return `${BIN} — a small wrapper over the GitHub REST API.

USAGE
  ${BIN} <command> <subcommand> [flags]

COMMANDS
${rows.join('\n')}

GLOBAL FLAGS
  --token <token>   GitHub token (default: $GITHUB_TOKEN, then $GH_TOKEN)
  --api-url <url>   API base URL (default: $GITHUB_API_URL, then ${DEFAULT_API_URL})
  --json            Print raw JSON instead of a table
  -h, --help        Show help for a command
  --version         Print the version

EXAMPLES
  ${BIN} repo list --org SamSquaredSoftwares
  ${BIN} issue list SamSquaredSoftwares/GitHub-CLI --state all --limit 10
  ${BIN} pr list SamSquaredSoftwares/GitHub-CLI --json`;
}

function groupHelp(group: string): string {
  const subcommands = COMMANDS[group] ?? {};
  const rows = Object.entries(subcommands).map(
    ([name, spec]) => `  ${name.padEnd(10)}${spec.summary}`,
  );
  return `USAGE
  ${BIN} ${group} <subcommand> [flags]

SUBCOMMANDS
${rows.join('\n')}`;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new UsageError(`--limit must be a whole number between 1 and 1000 (got '${raw}').`);
  }
  return value;
}

function parseChoice(name: string, raw: string | undefined, choices: string[], fallback: string): string {
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (!choices.includes(value)) {
    throw new UsageError(`--${name} must be one of ${choices.join(', ')} (got '${raw}').`);
  }
  return value;
}

type OptionValue = string | boolean | string[] | undefined;

function str(value: OptionValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Flattens a repeatable option into a list.
 *
 * Both idioms work and mix freely: `--label a --label b` and `--label a,b`.
 */
function list(value: OptionValue): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Reads an option that the API accepts only one of. */
function single(name: string, value: OptionValue): string | undefined {
  const values = list(value);
  if (values.length > 1) {
    throw new UsageError(`--${name} may only be given once here (got ${values.length} values).`);
  }
  return values[0];
}

function requireOption(name: string, value: OptionValue): string {
  const text = str(value);
  if (text === undefined || text === '') {
    throw new UsageError(`Missing required flag --${name}.`);
  }
  return text;
}

function requirePositional(positionals: string[], index: number, what: string): string {
  const value = positionals[index];
  if (value === undefined || value === '') {
    throw new UsageError(`Missing required argument <${what}>.`, `Expected ${REPO_ARG_HINT}.`);
  }
  return value;
}

export interface RunContext {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch | undefined;
  /** Injection seam for `--body-file -`; defaults to the real stdin. */
  readStdin?: StdinReader | undefined;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/**
 * Runs the CLI and resolves to a process exit code.
 *
 * Errors are not thrown past this boundary: `CliError` is rendered as a
 * message, anything else is re-thrown for the top-level handler to report.
 */
export async function run(context: RunContext): Promise<number> {
  const env = context.env ?? process.env;
  const io: IO = {
    out: context.out ?? consoleIO.out,
    err: context.err ?? consoleIO.err,
  };
  const out = io.out;

  let values: Partial<Record<OptionName, OptionValue>>;
  let positionals: string[];
  let provided: Set<string>;
  try {
    const parsed = parseArgs({
      args: context.argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
    values = parsed.values as Partial<Record<OptionName, OptionValue>>;
    positionals = parsed.positionals;
    provided = new Set(
      parsed.tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : [])),
    );
  } catch (cause) {
    throw new UsageError((cause as Error).message, `Run '${BIN} --help' to see available flags.`);
  }

  const wantsHelp = values.help === true;
  const [group, subcommand] = positionals;

  if (values.version === true && !wantsHelp) {
    out(await readVersion());
    return EXIT_OK;
  }

  if (group === undefined) {
    if (wantsHelp) {
      out(rootHelp());
      return EXIT_OK;
    }
    throw new UsageError('No command given.', `Run '${BIN} --help' to see available commands.`);
  }

  const subcommands = COMMANDS[group];
  if (subcommands === undefined) {
    throw new UsageError(
      `Unknown command '${group}'.`,
      `Available commands: ${Object.keys(COMMANDS).join(', ')}.`,
    );
  }

  if (subcommand === undefined) {
    if (wantsHelp) {
      out(groupHelp(group));
      return EXIT_OK;
    }
    throw new UsageError(
      `'${group}' needs a subcommand.`,
      `Available subcommands: ${Object.keys(subcommands).join(', ')}.`,
    );
  }

  const spec = subcommands[subcommand];
  if (spec === undefined) {
    throw new UsageError(
      `Unknown subcommand '${group} ${subcommand}'.`,
      `Available subcommands: ${Object.keys(subcommands).join(', ')}.`,
    );
  }

  if (wantsHelp) {
    out(spec.help);
    return EXIT_OK;
  }

  const allowed = new Set<string>([...GLOBAL_OPTIONS, ...spec.options]);
  for (const name of provided) {
    if (!allowed.has(name)) {
      throw new UsageError(
        `'${group} ${subcommand}' does not accept --${name}.`,
        `Run '${BIN} ${group} ${subcommand} --help' to see its flags.`,
      );
    }
  }

  const expectedPositionals = spec.args === '' ? 2 : 3;
  if (positionals.length > expectedPositionals) {
    throw new UsageError(
      `Unexpected argument '${positionals[expectedPositionals]}'.`,
      `Run '${BIN} ${group} ${subcommand} --help' for usage.`,
    );
  }

  const client = new GitHubClient({
    token: resolveToken(str(values.token), env),
    apiUrl: str(values['api-url']) ?? env['GITHUB_API_URL'] ?? DEFAULT_API_URL,
    fetchImpl: context.fetchImpl,
  });

  const json = values.json === true;

  if (group === 'repo') {
    await repoList(client, {
      user: str(values.user),
      org: str(values.org),
      sort: parseChoice('sort', str(values.sort), REPO_SORTS, 'pushed'),
      limit: parseLimit(str(values.limit), 30),
      json,
    }, io);
    return EXIT_OK;
  }

  const repo = parseRepoRef(requirePositional(positionals, 2, 'repository'));

  if (subcommand === 'create') {
    const body = await resolveBody(
      { body: str(values.body), bodyFile: str(values['body-file']) },
      context.readStdin ?? readProcessStdin,
    );
    const title = requireOption('title', values.title);

    if (group === 'issue') {
      await issueCreate(client, repo, {
        title,
        body,
        labels: list(values.label),
        assignees: list(values.assignee),
        json,
      }, io);
      return EXIT_OK;
    }

    await prCreate(client, repo, {
      title,
      head: requireOption('head', values.head),
      base: str(values.base),
      body,
      draft: values.draft === true,
      json,
    }, io);
    return EXIT_OK;
  }

  const state = parseChoice('state', str(values.state), STATES, 'open');
  const limit = parseLimit(str(values.limit), 30);

  if (group === 'issue') {
    await issueList(client, repo, {
      // The API filters on a comma-separated label list, ANDing the names.
      label: list(values.label).join(',') || undefined,
      assignee: single('assignee', values.assignee),
      state,
      limit,
      json,
    }, io);
    return EXIT_OK;
  }

  await prList(client, repo, {
    state,
    base: str(values.base),
    limit,
    json,
  }, io);
  return EXIT_OK;
}

/** Precedence: explicit flag, then GITHUB_TOKEN, then GH_TOKEN. */
function resolveToken(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  return [flag, env['GITHUB_TOKEN'], env['GH_TOKEN']].find(
    (value) => value !== undefined && value !== '',
  );
}

let cachedVersion: string | undefined;

/** Reads the version out of package.json, which ships alongside `dist/`. */
export async function readVersion(): Promise<string> {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/**
 * Runs the CLI and converts any error into an exit code.
 *
 * This is the entrypoint's whole body, so tests exercise the same path a real
 * invocation takes.
 */
export async function execute(context: RunContext): Promise<number> {
  const err = context.err ?? ((text: string) => console.error(text));
  try {
    return await run(context);
  } catch (error) {
    return reportError(error, err);
  }
}

/** Renders a caught error and returns the exit code to use. */
export function reportError(error: unknown, err: (text: string) => void): number {
  if (error instanceof CliError) {
    err(`error: ${error.message}`);
    if (error.hint !== undefined) err(`hint: ${error.hint}`);
    return error.exitCode;
  }
  err(`error: ${(error as Error)?.stack ?? String(error)}`);
  return 1;
}
