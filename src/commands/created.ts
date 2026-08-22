import type { GitHubClient } from '../client.js';
import { UsageError } from '../errors.js';
import { printJson, type IO } from '../output.js';

/** The fields every create command reports back. */
export interface Created {
  number: number;
  html_url: string;
}

/**
 * Refuses a write before it is attempted when no token is present.
 *
 * GitHub answers an unauthenticated write with a 404 that looks like a missing
 * repository, which sends people looking for the wrong problem.
 */
export function requireAuth(client: GitHubClient, action: string): void {
  if (client.authenticated) return;
  throw new UsageError(
    `${action} requires authentication.`,
    'Pass --token or set GITHUB_TOKEN. The token needs write access to the repository.',
  );
}

/** Prints the created resource: its URL by default, the full payload with --json. */
export function printCreated(created: Created, json: boolean, io: IO): void {
  if (json) {
    printJson(created, io.out);
    return;
  }
  io.out(created.html_url);
}
