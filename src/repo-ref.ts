import { UsageError } from './errors.js';

export interface RepoRef {
  owner: string;
  name: string;
}

// GitHub allows alphanumerics, hyphens, underscores and dots in these segments.
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Parses a repository reference.
 *
 * Accepts the canonical `owner/repo` form as well as the URLs people paste out
 * of a browser or a git remote: `https://github.com/owner/repo`,
 * `git@github.com:owner/repo.git`.
 */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();
  if (trimmed === '') throw new UsageError('Missing repository. Expected OWNER/REPO.');

  let candidate = trimmed;
  const sshMatch = /^(?:ssh:\/\/)?git@[^:/]+[:/](.+)$/.exec(candidate);
  if (sshMatch?.[1] !== undefined) {
    candidate = sshMatch[1];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new UsageError(`Could not parse '${input}' as a repository.`, 'Expected OWNER/REPO.');
    }
    candidate = url.pathname;
  }

  candidate = candidate.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');

  const parts = candidate.split('/');
  if (parts.length !== 2) {
    throw new UsageError(
      `Could not parse '${input}' as a repository.`,
      "Expected OWNER/REPO, for example 'SamSquaredSoftwares/GitHub-CLI'.",
    );
  }

  const [owner, name] = parts;
  if (owner === undefined || name === undefined || !SEGMENT.test(owner) || !SEGMENT.test(name)) {
    throw new UsageError(
      `Could not parse '${input}' as a repository.`,
      "Expected OWNER/REPO, for example 'SamSquaredSoftwares/GitHub-CLI'.",
    );
  }

  return { owner, name };
}
