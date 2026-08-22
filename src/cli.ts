import { parseArgs } from 'node:util';
import { GitHubClient, DEFAULT_API_URL } from './client.js';
import { CliError, UsageError, EXIT_OK } from './errors.js';
import { consoleIO, type IO } from './output.js';
import { parseRepoRef } from './repo-ref.js';
import { repoList } from './commands/repo.js';
import { issueList } from './commands/issue.js';
import { prList } from './commands/pr.js';

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
  label: { type: 'string' },
  assignee: { type: 'string' },
  base: { type: 'string' },
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

  let values: Partial<Record<OptionName, string | boolean>>;
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
    values = parsed.values as Partial<Record<OptionName, string | boolean>>;
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
    token: resolveToken(values.token, env),
    apiUrl: (values['api-url'] as string | undefined) ?? env['GITHUB_API_URL'] ?? DEFAULT_API_URL,
    fetchImpl: context.fetchImpl,
  });

  const json = values.json === true;
  const limit = parseLimit(values.limit as string | undefined, 30);

  if (group === 'repo') {
    await repoList(client, {
      user: values.user as string | undefined,
      org: values.org as string | undefined,
      sort: parseChoice('sort', values.sort as string | undefined, REPO_SORTS, 'pushed'),
      limit,
      json,
    }, io);
    return EXIT_OK;
  }

  const repo = parseRepoRef(requirePositional(positionals, 2, 'repository'));
  const state = parseChoice('state', values.state as string | undefined, STATES, 'open');

  if (group === 'issue') {
    await issueList(client, repo, {
      state,
      label: values.label as string | undefined,
      assignee: values.assignee as string | undefined,
      limit,
      json,
    }, io);
    return EXIT_OK;
  }

  await prList(client, repo, {
    state,
    base: values.base as string | undefined,
    limit,
    json,
  }, io);
  return EXIT_OK;
}

/** Precedence: explicit flag, then GITHUB_TOKEN, then GH_TOKEN. */
function resolveToken(flag: string | boolean | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [typeof flag === 'string' ? flag : undefined, env['GITHUB_TOKEN'], env['GH_TOKEN']];
  return candidates.find((value) => value !== undefined && value !== '');
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
