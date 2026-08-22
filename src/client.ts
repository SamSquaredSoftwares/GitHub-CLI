import { CliError } from './errors.js';

export const DEFAULT_API_URL = 'https://api.github.com';
export const USER_AGENT = 'samsquaredsoftwares-github-cli';

/** Values accepted as query-string parameters. `undefined` entries are dropped. */
export type QueryParams = Record<string, string | number | undefined>;

export interface ClientOptions {
  token?: string | undefined;
  apiUrl?: string | undefined;
  /** Injection seam for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
}

/** A non-2xx response from the GitHub API. */
export class GitHubApiError extends CliError {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string, hint?: string) {
    super(message, { hint });
    this.name = 'GitHubApiError';
    this.status = status;
    this.url = url;
  }
}

/** Shape of GitHub's JSON error bodies. Every field is best-effort. */
interface ApiErrorBody {
  message?: unknown;
  documentation_url?: unknown;
  /** Field-level detail, sent with 422 Unprocessable Entity. */
  errors?: unknown;
}

/**
 * Renders GitHub's field-level validation errors as `field: reason` pairs.
 *
 * A bare "Validation Failed" says nothing about which field was wrong, and
 * that is exactly what a create command needs to report.
 */
function describeFieldErrors(errors: unknown): string | undefined {
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const described = errors.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry === null || typeof entry !== 'object') return [];
    const { field, code, message } = entry as Record<string, unknown>;
    const reason =
      typeof message === 'string' ? message : typeof code === 'string' ? code : undefined;
    if (reason === undefined) return [];
    return [typeof field === 'string' ? `${field}: ${reason}` : reason];
  });
  return described.length === 0 ? undefined : described.join('; ');
}

/**
 * Parses a `Link` header and returns the URL marked `rel="next"`, if any.
 *
 * GitHub's pagination cursors are opaque, so following the header is the only
 * supported way to walk a list past the first page.
 */
export function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (!match) continue;
    const [, url, attrs] = match;
    if (url !== undefined && /\brel\s*=\s*"?next"?/.test(attrs ?? '')) return url;
  }
  return undefined;
}

function buildUrl(apiUrl: string, path: string, params: QueryParams): string {
  const url = new URL(path.replace(/^\//, ''), apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function describeRateLimitReset(header: string | null): string | undefined {
  const epochSeconds = Number(header);
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return undefined;
  const resetAt = new Date(epochSeconds * 1000);
  const minutes = Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / 60_000));
  return `Limit resets at ${resetAt.toISOString()} (about ${minutes} minute${minutes === 1 ? '' : 's'} from now).`;
}

/** A thin, dependency-free wrapper over the GitHub REST API. */
export class GitHubClient {
  private readonly token: string | undefined;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.token = options.token;
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get authenticated(): boolean {
    return this.token !== undefined && this.token !== '';
  }

  private headers(hasBody = false): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    };
    if (this.authenticated) headers['Authorization'] = `Bearer ${this.token}`;
    if (hasBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers: this.headers(init.body != null) });
    } catch (cause) {
      throw new CliError(`Could not reach ${new URL(url).host}: ${(cause as Error).message}`, {
        hint: 'Check your network connection or --api-url.',
      });
    }
    if (!response.ok) throw await this.toApiError(response, url);
    return response;
  }

  private async toApiError(response: Response, url: string): Promise<GitHubApiError> {
    let apiMessage: string | undefined;
    let documentationUrl: string | undefined;
    let fieldErrors: string | undefined;
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (typeof body.message === 'string') apiMessage = body.message;
      if (typeof body.documentation_url === 'string') documentationUrl = body.documentation_url;
      fieldErrors = describeFieldErrors(body.errors);
    } catch {
      // Non-JSON error bodies (proxies, gateways) carry nothing worth showing.
    }

    const apiSummary = apiMessage ?? response.statusText ?? 'Unknown error';
    const summary = fieldErrors === undefined ? apiSummary : `${apiSummary} (${fieldErrors})`;
    const rateLimited =
      (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0';

    if (rateLimited) {
      const parts = [describeRateLimitReset(response.headers.get('x-ratelimit-reset'))];
      if (!this.authenticated) {
        parts.push('Authenticate with --token or GITHUB_TOKEN for a much higher rate limit.');
      }
      return new GitHubApiError(
        `GitHub rate limit exceeded (HTTP ${response.status}).`,
        response.status,
        url,
        parts.filter(Boolean).join(' '),
      );
    }

    let hint: string | undefined;
    if (response.status === 401) {
      hint = 'The token was rejected. Check that it is valid and has not expired.';
    } else if (response.status === 403) {
      hint = 'The token is valid but lacks permission. A write needs the `repo` scope, or fine-grained write access to this repository.';
    } else if (response.status === 404) {
      hint = this.authenticated
        ? 'Check the name, and that your token can see this resource.'
        : 'Private resources return 404 when unauthenticated — try --token or GITHUB_TOKEN.';
    } else if (documentationUrl !== undefined) {
      hint = `See ${documentationUrl}`;
    }

    return new GitHubApiError(
      `GitHub API request failed (HTTP ${response.status}): ${summary}`,
      response.status,
      url,
      hint,
    );
  }

  /** Fetches a single JSON resource. */
  async get<T>(path: string, params: QueryParams = {}): Promise<T> {
    const response = await this.request(buildUrl(this.apiUrl, path, params));
    return (await response.json()) as T;
  }

  private async send<T>(method: string, path: string, body: unknown): Promise<T> {
    const response = await this.request(buildUrl(this.apiUrl, path, {}), {
      method,
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  }

  /** Creates a resource and returns the created object. */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('POST', path, body);
  }

  /** Updates a resource and returns the updated object. */
  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('PATCH', path, body);
  }

  /** Replaces or performs an action on a resource, e.g. merging a pull request. */
  async put<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('PUT', path, body);
  }

  /**
   * Deletes a resource.
   *
   * Returns nothing: GitHub answers a delete with `204 No Content`, so there
   * is no body to parse.
   */
  async delete(path: string): Promise<void> {
    await this.request(buildUrl(this.apiUrl, path, {}), { method: 'DELETE' });
  }

  /**
   * Yields items from a paginated collection, following `Link: rel="next"`
   * until the source is exhausted or the consumer stops iterating.
   */
  async *paginate<T>(path: string, params: QueryParams = {}, perPage = 100): AsyncGenerator<T> {
    let url: string | undefined = buildUrl(this.apiUrl, path, { per_page: perPage, ...params });
    while (url !== undefined) {
      const response: Response = await this.request(url);
      const page = (await response.json()) as T[];
      if (!Array.isArray(page)) {
        throw new CliError(`Expected a list from ${url} but got a single object.`);
      }
      for (const item of page) yield item;
      if (page.length === 0) break;
      url = parseNextLink(response.headers.get('link'));
    }
  }

  /**
   * Collects up to `limit` items, optionally skipping some.
   *
   * `keep` runs before the limit is applied, so filtered-out entries (such as
   * pull requests returned by the issues endpoint) do not consume the budget.
   */
  async list<T>(
    path: string,
    params: QueryParams = {},
    limit = 30,
    keep: (item: T) => boolean = () => true,
  ): Promise<T[]> {
    if (limit <= 0) return [];
    const perPage = Math.min(100, Math.max(limit, 30));
    const results: T[] = [];
    for await (const item of this.paginate<T>(path, params, perPage)) {
      if (!keep(item)) continue;
      results.push(item);
      if (results.length >= limit) break;
    }
    return results;
  }
}
