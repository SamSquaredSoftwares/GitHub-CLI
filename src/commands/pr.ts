import type { GitHubClient } from '../client.js';
import { CliError, UsageError } from '../errors.js';
import { printCreated, requireAuth } from './created.js';
import { formatRelativeTime, printJson, printRows, type Column, type IO } from '../output.js';
import type { RepoRef } from '../repo-ref.js';

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  user: { login: string } | null;
  head: { label?: string; ref: string } | null;
  base: { ref: string } | null;
  merged_at: string | null;
  updated_at: string;
  html_url: string;
}

export interface PrListOptions {
  state: string;
  base?: string | undefined;
  limit: number;
  json: boolean;
}

const COLUMNS: Column<PullRequest>[] = [
  { header: '#', value: (p) => String(p.number) },
  {
    header: 'state',
    value: (p) => {
      if (p.merged_at !== null && p.merged_at !== undefined) return 'merged';
      return p.draft ? 'draft' : p.state;
    },
  },
  { header: 'title', value: (p) => p.title, maxWidth: 60 },
  { header: 'author', value: (p) => p.user?.login ?? '-' },
  {
    header: 'branch',
    value: (p) => (p.head === null ? '' : `${p.head.ref} → ${p.base?.ref ?? '?'}`),
    maxWidth: 40,
  },
  { header: 'updated', value: (p) => formatRelativeTime(p.updated_at) },
];

export async function prList(
  client: GitHubClient,
  repo: RepoRef,
  options: PrListOptions,
  io: IO,
): Promise<void> {
  const pulls = await client.list<PullRequest>(
    `repos/${repo.owner}/${repo.name}/pulls`,
    { state: options.state, base: options.base },
    options.limit,
  );

  printRows(pulls, COLUMNS, {
    json: options.json,
    emptyMessage: `No ${options.state === 'all' ? '' : `${options.state} `}pull requests found in ${repo.owner}/${repo.name}.`,
  }, io);
}

export interface PrCreateOptions {
  title: string;
  head: string;
  base?: string | undefined;
  body?: string | undefined;
  draft: boolean;
  json: boolean;
}

/** Only the field we need off `GET /repos/{owner}/{repo}`. */
interface RepoDefaults {
  default_branch: string;
}

export async function prCreate(
  client: GitHubClient,
  repo: RepoRef,
  options: PrCreateOptions,
  io: IO,
): Promise<void> {
  requireAuth(client, 'Creating a pull request');

  // Without an explicit --base, target whatever the repository calls its
  // default branch rather than assuming it is named `main`.
  let base = options.base;
  if (base === undefined) {
    const defaults = await client.get<RepoDefaults>(`repos/${repo.owner}/${repo.name}`);
    base = defaults.default_branch;
  }

  if (base === options.head) {
    throw new UsageError(
      `--head and --base are both '${base}'; a pull request needs two different branches.`,
    );
  }

  const created = await client.post<PullRequest>(`repos/${repo.owner}/${repo.name}/pulls`, {
    title: options.title,
    head: options.head,
    base,
    draft: options.draft,
    ...(options.body === undefined ? {} : { body: options.body }),
  });

  printCreated(created, options.json, io);
}

/** `GET /repos/{owner}/{repo}/pulls/{number}` — more than the list view carries. */
interface PullRequestDetail {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  /** null while GitHub is still computing mergeability. */
  mergeable: boolean | null;
  merge_commit_sha: string | null;
  head: { ref: string; repo: { full_name: string } | null } | null;
  base: { ref: string; repo: { full_name: string; default_branch: string } | null } | null;
  html_url: string;
}

interface MergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

export interface PrMergeOptions {
  number: number;
  method: string;
  subject?: string | undefined;
  message?: string | undefined;
  deleteBranch: boolean;
  json: boolean;
}

export async function prMerge(
  client: GitHubClient,
  repo: RepoRef,
  options: PrMergeOptions,
  io: IO,
): Promise<void> {
  requireAuth(client, 'Merging a pull request');

  const ref = `${repo.owner}/${repo.name}#${options.number}`;
  const path = `repos/${repo.owner}/${repo.name}/pulls/${options.number}`;
  const pull = await client.get<PullRequestDetail>(path);

  // Preflight, so the common refusals read as themselves rather than as
  // GitHub's catch-all 405 "Pull Request is not mergeable".
  if (pull.merged) {
    io.err(`${ref} is already merged.`);
    if (options.json) printJson(pull, io.out);
    else if (pull.merge_commit_sha !== null) io.out(pull.merge_commit_sha);
    return;
  }
  if (pull.state === 'closed') {
    throw new CliError(`${ref} is closed without having been merged.`, {
      hint: 'Reopen it on GitHub before merging.',
    });
  }
  if (pull.draft) {
    throw new UsageError(`${ref} is a draft.`, 'Mark it ready for review before merging.');
  }
  if (pull.mergeable === false) {
    throw new CliError(`${ref} has conflicts with its base branch.`, {
      hint: 'Merge the base branch into the head branch and resolve them first.',
    });
  }
  if (pull.mergeable === null) {
    io.err(`GitHub has not finished checking whether ${ref} is mergeable; attempting the merge anyway.`);
  }

  const result = await client.put<MergeResult>(`${path}/merge`, {
    merge_method: options.method,
    ...(options.subject === undefined ? {} : { commit_title: options.subject }),
    ...(options.message === undefined ? {} : { commit_message: options.message }),
  });

  if (options.deleteBranch) await deleteHeadBranch(client, repo, pull, io);

  if (options.json) printJson(result, io.out);
  else io.out(result.sha);
}

/**
 * Deletes the merged branch, declining the cases where it would be wrong.
 *
 * A fork's branch lives in another repository, and deleting a default branch
 * would break the repository outright.
 */
async function deleteHeadBranch(
  client: GitHubClient,
  repo: RepoRef,
  pull: PullRequestDetail,
  io: IO,
): Promise<void> {
  const branch = pull.head?.ref;
  if (branch === undefined) {
    io.err('Merged, but the head branch could not be determined, so it was left in place.');
    return;
  }
  if (pull.head?.repo?.full_name !== `${repo.owner}/${repo.name}`) {
    io.err(`Merged, but '${branch}' lives in a fork, so it was left in place.`);
    return;
  }
  if (branch === pull.base?.repo?.default_branch) {
    io.err(`Merged, but '${branch}' is the default branch, so it was left in place.`);
    return;
  }

  try {
    await client.delete(`repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`);
  } catch (cause) {
    // The merge already succeeded; a failed cleanup must not fail the command.
    io.err(`Merged, but deleting '${branch}' failed: ${(cause as Error).message}`);
  }
}
