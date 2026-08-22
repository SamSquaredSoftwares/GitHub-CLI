import type { GitHubClient } from '../client.js';
import { UsageError } from '../errors.js';
import { formatRelativeTime, printRows, type Column, type IO } from '../output.js';

export interface Repo {
  full_name: string;
  name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
  language: string | null;
  description: string | null;
  pushed_at: string | null;
  html_url: string;
}

export interface RepoListOptions {
  user?: string | undefined;
  org?: string | undefined;
  limit: number;
  json: boolean;
  sort: string;
}

const COLUMNS: Column<Repo>[] = [
  { header: 'name', value: (r) => r.full_name, maxWidth: 48 },
  {
    header: 'visibility',
    value: (r) => {
      const flags = [r.private ? 'private' : 'public'];
      if (r.fork) flags.push('fork');
      if (r.archived) flags.push('archived');
      return flags.join(', ');
    },
  },
  { header: 'stars', value: (r) => String(r.stargazers_count ?? 0) },
  { header: 'language', value: (r) => r.language ?? '-' },
  { header: 'pushed', value: (r) => formatRelativeTime(r.pushed_at) },
  { header: 'description', value: (r) => r.description ?? '', maxWidth: 60 },
];

export async function repoList(
  client: GitHubClient,
  options: RepoListOptions,
  io: IO,
): Promise<void> {
  if (options.user !== undefined && options.org !== undefined) {
    throw new UsageError('--user and --org cannot be combined.');
  }

  let path: string;
  if (options.org !== undefined) {
    path = `orgs/${encodeURIComponent(options.org)}/repos`;
  } else if (options.user !== undefined) {
    path = `users/${encodeURIComponent(options.user)}/repos`;
  } else {
    if (!client.authenticated) {
      throw new UsageError(
        'Listing your own repositories requires authentication.',
        'Pass --token, set GITHUB_TOKEN, or name a target with --user/--org.',
      );
    }
    path = 'user/repos';
  }

  const repos = await client.list<Repo>(path, { sort: options.sort }, options.limit);
  printRows(repos, COLUMNS, { json: options.json, emptyMessage: 'No repositories found.' }, io);
}
