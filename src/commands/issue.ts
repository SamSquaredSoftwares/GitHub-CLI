import type { GitHubClient } from '../client.js';
import { printCreated, requireAuth } from './created.js';
import { formatRelativeTime, printRows, type Column, type IO } from '../output.js';
import type { RepoRef } from '../repo-ref.js';

export interface Issue {
  number: number;
  title: string;
  state: string;
  user: { login: string } | null;
  labels: ({ name?: string } | string)[];
  comments: number;
  updated_at: string;
  html_url: string;
  /** Present only when the item is actually a pull request. */
  pull_request?: unknown;
}

export interface IssueListOptions {
  state: string;
  label?: string | undefined;
  assignee?: string | undefined;
  limit: number;
  json: boolean;
}

function labelNames(issue: Issue): string {
  if (!Array.isArray(issue.labels)) return '';
  return issue.labels
    .map((label) => (typeof label === 'string' ? label : (label?.name ?? '')))
    .filter((name) => name !== '')
    .join(', ');
}

const COLUMNS: Column<Issue>[] = [
  { header: '#', value: (i) => String(i.number) },
  { header: 'state', value: (i) => i.state },
  { header: 'title', value: (i) => i.title, maxWidth: 60 },
  { header: 'author', value: (i) => i.user?.login ?? '-' },
  { header: 'labels', value: labelNames, maxWidth: 30 },
  { header: 'comments', value: (i) => String(i.comments ?? 0) },
  { header: 'updated', value: (i) => formatRelativeTime(i.updated_at) },
];

export async function issueList(
  client: GitHubClient,
  repo: RepoRef,
  options: IssueListOptions,
  io: IO,
): Promise<void> {
  const issues = await client.list<Issue>(
    `repos/${repo.owner}/${repo.name}/issues`,
    { state: options.state, labels: options.label, assignee: options.assignee },
    options.limit,
    // GitHub's issues endpoint returns pull requests too; they are only
    // distinguishable by the presence of a `pull_request` key.
    (issue) => issue.pull_request === undefined,
  );

  printRows(issues, COLUMNS, {
    json: options.json,
    emptyMessage: `No ${options.state === 'all' ? '' : `${options.state} `}issues found in ${repo.owner}/${repo.name}.`,
  }, io);
}

export interface IssueCreateOptions {
  title: string;
  body?: string | undefined;
  labels: string[];
  assignees: string[];
  json: boolean;
}

export async function issueCreate(
  client: GitHubClient,
  repo: RepoRef,
  options: IssueCreateOptions,
  io: IO,
): Promise<void> {
  requireAuth(client, 'Creating an issue');

  const created = await client.post<Issue>(`repos/${repo.owner}/${repo.name}/issues`, {
    title: options.title,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.labels.length === 0 ? {} : { labels: options.labels }),
    ...(options.assignees.length === 0 ? {} : { assignees: options.assignees }),
  });

  printCreated(created, options.json, io);
}
