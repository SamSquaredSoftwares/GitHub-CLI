import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  method: string;
  pathname: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  /** Parsed JSON request body, or undefined when there was none. */
  body: unknown;
}

export type Route = (request: {
  url: URL;
  headers: IncomingMessage['headers'];
  method: string;
  body: unknown;
}) => FakeResponse;

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
    const method = req.method ?? 'GET';
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({
        method,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });

      const route = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
      if (route === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }

      const result = route({ url, headers: req.headers, method, body });
      const status = result.status ?? 200;
      // 204 means no content; sending one would be a protocol violation.
      if (status === 204) {
        res.writeHead(status, result.headers ?? {});
        res.end();
        return;
      }
      res.writeHead(status, {
        'content-type': 'application/json',
        ...result.headers,
      });
      res.end(JSON.stringify(result.body ?? null));
    });
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
