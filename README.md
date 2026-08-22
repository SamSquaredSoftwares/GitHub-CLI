# GitHub-CLI

`ghcli` — a small command line wrapper over the GitHub REST API for listing
repositories, issues, and pull requests, and for opening issues and pull
requests.

Written in TypeScript for Node 20+, with **no runtime dependencies**: it uses
the platform `fetch`, `node:util`'s `parseArgs`, and `node:test`.

## Install

```bash
npm install
npm run build
node dist/src/index.js --help
```

To get a `ghcli` command on your `PATH`:

```bash
npm link
ghcli --help
```

## Usage

```
ghcli <command> <subcommand> [flags]
```

| Command | Description |
| --- | --- |
| `ghcli repo list` | List repositories for a user, an organization, or yourself |
| `ghcli issue list <repository>` | List issues in a repository |
| `ghcli issue create <repository>` | Open an issue in a repository |
| `ghcli pr list <repository>` | List pull requests in a repository |
| `ghcli pr create <repository>` | Open a pull request in a repository |

Global flags:

| Flag | Description |
| --- | --- |
| `--token <token>` | GitHub token (default: `$GITHUB_TOKEN`, then `$GH_TOKEN`) |
| `--api-url <url>` | API base URL (default: `$GITHUB_API_URL`, then `https://api.github.com`) — point this at a GitHub Enterprise Server |
| `--json` | Print the raw API payload instead of a table |
| `-h`, `--help` | Show help for a command |
| `--version` | Print the version |

`<repository>` accepts `OWNER/REPO` as well as the URLs you get from a browser
or a git remote: `https://github.com/acme/widgets`, `git@github.com:acme/widgets.git`.

### Examples

```bash
ghcli repo list --org acme --limit 10
ghcli repo list --user octocat --sort updated
ghcli repo list                              # your own repositories; needs a token

ghcli issue list acme/widgets
ghcli issue list acme/widgets --state all --label bug --assignee octocat

ghcli pr list acme/widgets --state all
ghcli pr list acme/widgets --base main --json
```

### Creating issues and pull requests

Both create commands print the URL of what they made, so the result pipes
straight into `open`, a Slack message, or another command:

```bash
ghcli issue create acme/widgets --title "Login times out" --body "Repro in the logs."
ghcli issue create acme/widgets --title "Flaky test" --label bug --label ci --assignee octocat

ghcli pr create acme/widgets --title "Add pagination" --head paginate
ghcli pr create acme/widgets --title "WIP" --head colour --base release --draft
```

`--label` and `--assignee` may be repeated or comma-separated, and the two
forms mix: `--label bug --label ci,urgent` sends all three.

Bodies can come from a file, or from stdin with `-`:

```bash
ghcli pr create acme/widgets --title "Add pagination" --head paginate --body-file NOTES.md

git log --oneline main..paginate |
  ghcli pr create acme/widgets --title "Add pagination" --head paginate --body-file -
```

`pr create` targets the repository's own default branch unless you pass
`--base`, so it does the right thing on repositories that do not call it
`main`. Both commands need a token with write access.

Output is a plain aligned table:

```
$ ghcli pr list acme/widgets --state all
#   STATE   TITLE                         AUTHOR   BRANCH            UPDATED
42  open    Add pagination to the client  octocat  paginate → main   30m ago
41  draft   WIP: colour output            mona     colour → main     4d ago
40  merged  Bootstrap the project         hubot    bootstrap → main  1mo ago
```

### Scripting

`--json` prints the API payload unchanged, so it composes with `jq`:

```bash
ghcli pr list acme/widgets --json | jq -r '.[] | "\(.number)\t\(.title)"'
```

Results go to stdout; diagnostics — including the "nothing matched" notice — go
to stderr, so a pipeline sees an empty stream rather than a prose message.

Exit codes: `0` success, `1` API or network failure, `2` usage error.

## Authentication

Unauthenticated requests work for public data but are rate limited to 60 per
hour per IP. Pass a token to raise that and to see private resources:

```bash
export GITHUB_TOKEN=ghp_...
ghcli repo list
```

A fine-grained token needs *Metadata: read* for repositories, plus
*Issues: read* and *Pull requests: read* for those listings. A classic token
needs the `repo` scope for private data; no scope is required for public data.

Without a token, private repositories are indistinguishable from missing ones —
GitHub returns `404` for both — so `ghcli` says as much in its error hint.

## Notes on behaviour

- **Pull requests are excluded from `issue list`.** GitHub's issues endpoint
  returns pull requests alongside issues; they are filtered out, and the filter
  is applied before `--limit`, so `--limit 10` yields ten issues rather than ten
  mixed rows.
- **Pagination follows `Link: rel="next"`** and stops as soon as `--limit` is
  satisfied, so a small limit costs a single request.
- **Titles are flattened to one line.** Titles are free-form user input and may
  contain newlines, tabs, or terminal escape sequences; those are stripped so
  they cannot break column alignment or write escapes to your terminal.
- **Rate limit errors report when the limit resets** and, when unauthenticated,
  suggest a token.
- **Creates fail fast without a token.** GitHub answers an unauthenticated
  write with a `404` that reads like a missing repository, so `ghcli` checks
  for a token before sending the request.
- **Validation failures name the field.** A bare `Validation Failed` becomes
  `Validation Failed (head: invalid)`.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # build, then node --test
npm run build        # emit dist/
```

Tests run against a local stand-in for `api.github.com` (`test/fake-github.ts`),
so the suite exercises real HTTP, real headers, and real `Link` pagination
without touching the network or consuming a rate limit.

```
src/
  index.ts          entrypoint (#!/usr/bin/env node)
  cli.ts            argument parsing, help text, dispatch
  client.ts         GitHub REST client: auth, pagination, error mapping
  output.ts         table rendering and JSON output
  repo-ref.ts       OWNER/REPO and repository URL parsing
  body.ts           --body / --body-file / stdin resolution
  errors.ts         CliError/UsageError and exit codes
  commands/         one module per subcommand
```

## License

MIT
