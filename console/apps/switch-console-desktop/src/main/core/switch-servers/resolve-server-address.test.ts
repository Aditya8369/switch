import { describe, expect, it } from 'vitest';
import { advertisedApiUrl, resolveServerAddress, type ResolveDeps } from './resolve-server-address';

/**
 * A fake network: each URL answers with what a real deployment would. Any URL
 * not listed refuses the connection, like a port nothing listens on.
 */
type Answer =
  | { json: unknown; status?: number }
  | { html: string; status?: number }
  | { status: number; text?: string }
  | 'timeout';

const json = (body: unknown, status = 200): Answer => ({ json: body, status });
const html: Answer = { html: '<!doctype html><title>Switch</title>' };
const notFound: Answer = { status: 404, text: '{"detail":"Not Found"}' };
const authConfig = json({ password_login_enabled: true, oidc_enabled: false });
const healthy = json({ status: 'ok' });

function network(answers: Record<string, Answer>): ResolveDeps & { requested: string[] } {
  const requested: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    const answer = answers[url];
    if (answer === undefined) throw new TypeError(`fetch failed: ECONNREFUSED ${url}`);
    if (answer === 'timeout') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    if ('json' in answer) {
      return new Response(JSON.stringify(answer.json), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if ('html' in answer) {
      return new Response(answer.html, {
        status: answer.status ?? 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(answer.text ?? '', {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, timeoutMs: 50, requested };
}

const DASH = 'https://switch.example.com';
const API = 'https://switch-api.example.com';

/** A current split deployment: the dashboard forwards `/gateway` to core. */
function splitServer(discovery: { gateway_url: string | null; api_url: string | null }) {
  return {
    [`${DASH}/gateway/discovery`]: json(discovery),
    [`${DASH}/gateway/auth/config`]: authConfig,
    [`${DASH}/health`]: html,
    [`${API}/gateway/discovery`]: json(discovery),
    [`${API}/gateway/auth/config`]: authConfig,
    [`${API}/health`]: healthy,
  } satisfies Record<string, Answer>;
}

describe('resolveServerAddress', () => {
  it('takes both origins from discovery when the dashboard address is typed', async () => {
    const net = network(splitServer({ gateway_url: DASH, api_url: API }));

    expect(await resolveServerAddress(DASH, net)).toEqual({
      kind: 'resolved',
      gatewayUrl: DASH,
      apiUrl: API,
      apiSource: 'discovered',
      manualReason: null,
      refusedApiUrl: null,
    });
  });

  it('takes both origins from discovery when the agent-bridge address is typed', async () => {
    const net = network(splitServer({ gateway_url: DASH, api_url: API }));

    expect(await resolveServerAddress(`${API}/`, net)).toMatchObject({
      gatewayUrl: DASH,
      apiUrl: API,
      apiSource: 'discovered',
    });
  });

  it('normalises what was typed and what the server said to bare origins', async () => {
    const net = network(splitServer({ gateway_url: `${DASH}/`, api_url: `${API}/` }));

    expect(await resolveServerAddress(`  ${DASH}/some/page  `, net)).toMatchObject({
      gatewayUrl: DASH,
      apiUrl: API,
    });
  });

  it('probes /health when the server names only its dashboard', async () => {
    const net = network(splitServer({ gateway_url: DASH, api_url: null }));

    // Typed the dashboard: /health there is HTML, so the person is asked.
    expect(await resolveServerAddress(DASH, net)).toMatchObject({
      gatewayUrl: DASH,
      apiUrl: null,
      apiSource: 'manual',
      manualReason: 'not_advertised',
    });
    // Typed the agent bridge: /health there is JSON, so it is the bridge.
    expect(await resolveServerAddress(API, net)).toMatchObject({
      gatewayUrl: DASH,
      apiUrl: API,
      apiSource: 'probed',
    });
  });

  it('settles a single-origin server from before discovery by its /health', async () => {
    const net = network({
      [`${API}/gateway/discovery`]: notFound,
      [`${API}/gateway/auth/config`]: authConfig,
      [`${API}/health`]: healthy,
    });

    expect(await resolveServerAddress(API, net)).toMatchObject({
      gatewayUrl: API,
      apiUrl: API,
      apiSource: 'probed',
    });
  });

  it('asks when a server from before discovery is reached through its dashboard', async () => {
    // The dashboard's nginx forwards /gateway (404 from old core) and answers
    // /health with the SPA's HTML.
    const net = network({
      [`${DASH}/gateway/discovery`]: notFound,
      [`${DASH}/gateway/auth/config`]: authConfig,
      [`${DASH}/health`]: html,
    });

    expect(await resolveServerAddress(DASH, net)).toEqual({
      kind: 'resolved',
      gatewayUrl: DASH,
      apiUrl: null,
      apiSource: 'manual',
      manualReason: 'not_advertised',
      refusedApiUrl: null,
    });
  });

  it('treats an HTML answer to discovery as no discovery', async () => {
    const net = network({
      [`${DASH}/gateway/discovery`]: html,
      [`${DASH}/gateway/auth/config`]: authConfig,
      [`${DASH}/health`]: healthy,
    });

    expect(await resolveServerAddress(DASH, net)).toMatchObject({
      apiSource: 'probed',
      apiUrl: DASH,
    });
  });

  it('moves on to the probe when discovery times out', async () => {
    const net = network({
      [`${API}/gateway/discovery`]: 'timeout',
      [`${API}/gateway/auth/config`]: authConfig,
      [`${API}/health`]: healthy,
    });

    expect(await resolveServerAddress(API, net)).toMatchObject({
      apiSource: 'probed',
      apiUrl: API,
    });
  });

  it('refuses a discovered agent address on plain http to another machine', async () => {
    const net = network(
      splitServer({ gateway_url: DASH, api_url: 'http://switch-api.example.com' })
    );

    expect(await resolveServerAddress(DASH, net)).toEqual({
      kind: 'resolved',
      gatewayUrl: DASH,
      apiUrl: null,
      apiSource: 'manual',
      manualReason: 'refused',
      refusedApiUrl: 'http://switch-api.example.com',
    });
  });

  it('accepts a discovered loopback agent address over plain http', async () => {
    const local = 'http://localhost:3000';
    const net = network({
      [`${local}/gateway/discovery`]: json({
        gateway_url: local,
        api_url: 'http://localhost:8000',
      }),
      [`${local}/gateway/auth/config`]: authConfig,
    });

    expect(await resolveServerAddress(local, net)).toMatchObject({
      gatewayUrl: local,
      apiUrl: 'http://localhost:8000',
      apiSource: 'discovered',
    });
  });

  it('refuses a probed agent address agents would not accept', async () => {
    const lan = 'http://10.0.0.5:8000';
    const net = network({
      [`${lan}/gateway/discovery`]: notFound,
      [`${lan}/gateway/auth/config`]: authConfig,
      [`${lan}/health`]: healthy,
    });

    expect(await resolveServerAddress(lan, net)).toMatchObject({
      apiUrl: null,
      manualReason: 'refused',
      refusedApiUrl: 'http://10.0.0.5:8000',
    });
  });

  it('falls back to the typed address when the named dashboard does not answer', async () => {
    const net = network({
      [`${API}/gateway/discovery`]: json({
        gateway_url: 'https://dashboard.internal',
        api_url: API,
      }),
      [`${API}/gateway/auth/config`]: authConfig,
    });

    expect(await resolveServerAddress(API, net)).toMatchObject({ gatewayUrl: API, apiUrl: API });
  });

  it('reports an address that answers nothing as unreachable', async () => {
    const net = network({});

    expect(await resolveServerAddress(DASH, net)).toEqual({ kind: 'unreachable', address: DASH });
  });

  it('reports a site that is not a Switch server as unreachable', async () => {
    const net = network({
      [`${DASH}/gateway/discovery`]: html,
      [`${DASH}/gateway/auth/config`]: html,
      [`${DASH}/health`]: healthy,
    });

    expect(await resolveServerAddress(DASH, net)).toEqual({ kind: 'unreachable', address: DASH });
  });

  it.each(['ftp://switch.example.com', 'switch.example.com', 'not a url', ''])(
    'refuses %j without a request',
    async (typed) => {
      const net = network({});

      expect(await resolveServerAddress(typed, net)).toEqual({ kind: 'invalid' });
      expect(net.requested).toEqual([]);
    }
  );
});

describe('advertisedApiUrl', () => {
  it('is the normalised origin the server advertises', async () => {
    const net = network(splitServer({ gateway_url: DASH, api_url: `${API}/` }));

    expect(await advertisedApiUrl(DASH, net)).toBe(API);
  });

  it.each([
    ['no discovery', { [`${DASH}/gateway/discovery`]: notFound }],
    ['no api_url', { [`${DASH}/gateway/discovery`]: json({ gateway_url: DASH, api_url: null }) }],
    [
      'an address agents refuse',
      {
        [`${DASH}/gateway/discovery`]: json({ gateway_url: DASH, api_url: 'http://x.example.com' }),
      },
    ],
    ['no answer', {}],
  ] as const)('is null for %s, and never probes', async (_label, answers) => {
    const net = network(answers as Record<string, Answer>);

    expect(await advertisedApiUrl(DASH, net)).toBeNull();
    expect(net.requested.every((url) => url.endsWith('/gateway/discovery'))).toBe(true);
  });
});
