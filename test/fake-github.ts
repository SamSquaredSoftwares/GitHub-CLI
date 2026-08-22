import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  pathname: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
}

export type Route = (request: { url: URL; headers: IncomingMessage['headers'] }) => FakeResponse;

export interface FakeGitHub {
  /** Base URL to hand to the client as `--api-url`. */
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * A local stand-in for api.github.com.
 *
 * Tests exercise the real fetch path, real headers, and real `Link` pagination
 * without touching the network or a rate limit.
 */
export async function startFakeGitHub(routes: Record<string, Route>): Promise<FakeGitHub> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    requests.push({
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
    });

    const route = routes[url.pathname];
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return;
    }

    const result = route({ url, headers: req.headers });
    res.writeHead(result.status ?? 200, {
      'content-type': 'application/json',
      ...result.headers,
    });
    res.end(JSON.stringify(result.body ?? null));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

let nextId = 1;

export function fakeRepo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = nextId++;
  return {
    id,
    name: `repo-${id}`,
    full_name: `acme/repo-${id}`,
    private: false,
    fork: false,
    archived: false,
    stargazers_count: 0,
    language: 'TypeScript',
    description: null,
    pushed_at: '2026-08-01T00:00:00Z',
    html_url: `https://github.com/acme/repo-${id}`,
    ...overrides,
  };
}

export function fakeIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = nextId++;
  return {
    number: id,
    title: `Issue ${id}`,
    state: 'open',
    user: { login: 'octocat' },
    labels: [],
    comments: 0,
    updated_at: '2026-08-20T00:00:00Z',
    html_url: `https://github.com/acme/widgets/issues/${id}`,
    ...overrides,
  };
}

export function fakePull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = nextId++;
  return {
    number: id,
    title: `Pull ${id}`,
    state: 'open',
    draft: false,
    user: { login: 'octocat' },
    head: { ref: `feature-${id}` },
    base: { ref: 'main' },
    merged_at: null,
    updated_at: '2026-08-20T00:00:00Z',
    html_url: `https://github.com/acme/widgets/pull/${id}`,
    ...overrides,
  };
}
