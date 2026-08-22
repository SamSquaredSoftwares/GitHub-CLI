import type { GitHubClient } from '../client.js';
import { formatRelativeTime, printRows, type Column, type IO } from '../output.js';
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
