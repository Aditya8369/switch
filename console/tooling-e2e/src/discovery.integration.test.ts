import { beforeAll, describe, expect, it } from 'vitest';
import { readDotEnvFile } from './env.ts';

/**
 * `GET /gateway/discovery` against a real switch-core: the endpoint Switch
 * Console asks to turn one typed address into a server's two.
 *
 * Needs only the server, not Mattermost or a console session, so it reads just
 * `SWITCH_API_URL`. Like the rest of the suite it **skips**, with the reason,
 * unless `SWITCH_E2E=1` is set and the server answers `/health`.
 *
 * Optional, to assert the configured values rather than only the shape:
 *
 * - `SWITCH_E2E_EXPECT_GATEWAY_URL`: what the server's `FRONTEND_BASE_URL` is.
 * - `SWITCH_E2E_EXPECT_API_URL`: what its `GATEWAY_PUBLIC_URL` is.
 * - `SWITCH_E2E_DASHBOARD_URL`: the dashboard origin, when it is served
 *   separately (the compose `gateway` profile), to check the answer is the
 *   same through it.
 */

const env: Record<string, string | undefined> = { ...readDotEnvFile(), ...process.env };
const apiUrl = env.SWITCH_API_URL?.replace(/\/+$/, '') ?? '';
let skip: string | null = null;

beforeAll(async () => {
  if (env.SWITCH_E2E !== '1') {
    skip = 'SWITCH_E2E=1 is not set (this suite drives a real Switch server)';
    return;
  }
  if (!apiUrl) {
    skip = 'SWITCH_API_URL is not set';
    return;
  }
  try {
    const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) skip = `Switch server at ${apiUrl} answered /health with ${health.status}`;
  } catch (error) {
    skip = `Switch server at ${apiUrl} is unreachable: ${error instanceof Error ? error.message : String(error)}`;
  }
});

async function discover(origin: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}/gateway/discovery`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() };
}

/** A bare origin: scheme and host (and port), nothing after. */
function isBareOrigin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

describe('GET /gateway/discovery on a live server', () => {
  it('answers without a session, with only the two origins', async (ctx) => {
    if (skip) return ctx.skip(skip);

    const { status, body } = await discover(apiUrl);

    expect(status).toBe(200);
    expect(Object.keys(body as object).sort()).toEqual(['api_url', 'gateway_url']);
    for (const value of Object.values(body as Record<string, unknown>)) {
      expect(value === null || isBareOrigin(value), `not null or a bare origin: ${value}`).toBe(
        true
      );
    }
  });

  it('reports the configured addresses', async (ctx) => {
    if (skip) return ctx.skip(skip);
    const expectGateway = env.SWITCH_E2E_EXPECT_GATEWAY_URL;
    const expectApi = env.SWITCH_E2E_EXPECT_API_URL;
    if (!expectGateway && !expectApi) {
      return ctx.skip(
        'set SWITCH_E2E_EXPECT_GATEWAY_URL / SWITCH_E2E_EXPECT_API_URL to check values'
      );
    }

    const { body } = await discover(apiUrl);

    if (expectGateway) expect((body as { gateway_url: unknown }).gateway_url).toBe(expectGateway);
    if (expectApi) expect((body as { api_url: unknown }).api_url).toBe(expectApi);
  });

  it('answers the same through a separately served dashboard', async (ctx) => {
    if (skip) return ctx.skip(skip);
    const dashboard = env.SWITCH_E2E_DASHBOARD_URL?.replace(/\/+$/, '');
    if (!dashboard) return ctx.skip('set SWITCH_E2E_DASHBOARD_URL to check through the dashboard');

    const [direct, viaDashboard] = await Promise.all([discover(apiUrl), discover(dashboard)]);

    expect(viaDashboard.status).toBe(200);
    expect(viaDashboard.body).toEqual(direct.body);
  });
});
