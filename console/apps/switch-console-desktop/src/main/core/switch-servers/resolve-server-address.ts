import { checkAgentEndpoint } from '@switch-console/shared';
import { z } from 'zod';
import type { ServerAddressResolution } from '@shared/core/switch-servers/server-address';
import { urlOrigin } from '@shared/core/switch-servers/switch-servers';

/**
 * Works out a server's dashboard and agent-bridge origins from one address.
 *
 * In order:
 *
 * 1. `GET <typed>/gateway/discovery`. Every deployment forwards `/gateway` to
 *    switch-core, so this answers on whichever address was typed. A server
 *    from before discovery answers 404 (or the dashboard's HTML).
 * 2. If that did not name the agent bridge, `GET <typed>/health`. The bridge
 *    answers JSON `{"status": "ok"}` there; the dashboard answers its HTML
 *    page. JSON means the agent bridge is at the typed address.
 * 3. Otherwise the person is asked, as they always were.
 *
 * An agent address is only ever taken if agents would accept it
 * (`checkAgentEndpoint`), since Console writes it into every agent on the
 * server. And the origin Console will sign in on must answer
 * `/gateway/auth/config` like a Switch server, or nothing is saved.
 *
 * Each request has its own short timeout, and a timeout is treated like any
 * other non-answer: the next step decides.
 */

export type ResolveDeps = {
  fetch: typeof fetch;
  /** Per request. */
  timeoutMs: number;
};

const DEFAULT_DEPS: ResolveDeps = { fetch: (...args) => fetch(...args), timeoutMs: 5_000 };

const discoverySchema = z.object({
  gateway_url: z.string().nullable(),
  api_url: z.string().nullable(),
});

const healthSchema = z.object({ status: z.literal('ok') });

const authConfigSchema = z.object({ password_login_enabled: z.boolean() });

/** The typed address as an http(s) origin, or null if it is not one. */
function typedOrigin(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

/** GET `url` and parse a JSON body with `schema`; null on any failure. */
async function getJson<T>(url: string, schema: z.ZodType<T>, deps: ResolveDeps): Promise<T | null> {
  try {
    const response = await deps.fetch(url, {
      headers: { Accept: 'application/json' },
      // A redirect would be to somewhere else entirely; don't follow it.
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (!response.ok) return null;
    // The dashboard answers every unknown path with its HTML page and 200.
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return null;
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function answersAsSwitch(origin: string, deps: ResolveDeps): Promise<boolean> {
  return (await getJson(`${origin}/gateway/auth/config`, authConfigSchema, deps)) !== null;
}

export async function resolveServerAddress(
  address: string,
  deps: ResolveDeps = DEFAULT_DEPS
): Promise<ServerAddressResolution> {
  const typed = typedOrigin(address);
  if (typed === null) return { kind: 'invalid' };

  const discovered = await getJson(`${typed}/gateway/discovery`, discoverySchema, deps);

  // The origin to sign in on: the dashboard the server names, when it answers;
  // otherwise the typed one, which answered `/gateway` (or will be checked).
  const advertisedGateway = discovered?.gateway_url ? urlOrigin(discovered.gateway_url) : null;
  let gatewayUrl: string | null = null;
  if (advertisedGateway && advertisedGateway !== typed) {
    if (await answersAsSwitch(advertisedGateway, deps)) gatewayUrl = advertisedGateway;
  }
  if (gatewayUrl === null) {
    if (!(await answersAsSwitch(typed, deps))) return { kind: 'unreachable', address: typed };
    gatewayUrl = typed;
  }

  if (discovered?.api_url) {
    const checked = checkAgentEndpoint(discovered.api_url);
    return checked.ok
      ? resolved(gatewayUrl, checked.endpoint, 'discovered')
      : refused(gatewayUrl, discovered.api_url);
  }

  const health = await getJson(`${typed}/health`, healthSchema, deps);
  if (health !== null) {
    const checked = checkAgentEndpoint(typed);
    return checked.ok
      ? resolved(gatewayUrl, checked.endpoint, 'probed')
      : refused(gatewayUrl, typed);
  }

  return {
    kind: 'resolved',
    gatewayUrl,
    apiUrl: null,
    apiSource: 'manual',
    manualReason: 'not_advertised',
    refusedApiUrl: null,
  };
}

function resolved(
  gatewayUrl: string,
  apiUrl: string,
  apiSource: 'discovered' | 'probed'
): ServerAddressResolution {
  return {
    kind: 'resolved',
    gatewayUrl,
    apiUrl,
    apiSource,
    manualReason: null,
    refusedApiUrl: null,
  };
}

function refused(gatewayUrl: string, refusedApiUrl: string): ServerAddressResolution {
  return {
    kind: 'resolved',
    gatewayUrl,
    apiUrl: null,
    apiSource: 'manual',
    manualReason: 'refused',
    refusedApiUrl,
  };
}

/**
 * What the server says about its agent address right now, for a server that is
 * already saved: the normalised origin it advertises, or null when it says
 * nothing (no discovery, no `api_url`, or no answer). Never probes: a saved
 * server already has an agent address, and only the server's own word is
 * reason to suggest another.
 */
export async function advertisedApiUrl(
  gatewayUrl: string,
  deps: ResolveDeps = DEFAULT_DEPS
): Promise<string | null> {
  const discovered = await getJson(`${gatewayUrl}/gateway/discovery`, discoverySchema, deps);
  if (!discovered?.api_url) return null;
  const checked = checkAgentEndpoint(discovered.api_url);
  return checked.ok ? checked.endpoint : null;
}
