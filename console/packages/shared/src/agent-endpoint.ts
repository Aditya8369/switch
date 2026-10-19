/**
 * The one rule for an agent bridge address (an agent's `SWITCH_API_ENDPOINT`,
 * an agents controller's `--server`).
 *
 * Whatever holds that address sends an agent's token to it, so it must be
 * HTTPS, or plain HTTP to a server on this machine. It also must not carry
 * credentials, a query or a fragment. The session host, the agents controller
 * and Switch Console all apply this rule, and they share this function so that
 * Console never saves an address the other two would refuse.
 */

/** Hostnames that name this machine, as `URL.hostname` spells them. */
export const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

export type AgentEndpointProblem = 'not_a_url' | 'insecure' | 'has_extras';

export type AgentEndpointCheck =
  | { ok: true; endpoint: string }
  | { ok: false; problem: AgentEndpointProblem };

/** Whether `hostname` (from a parsed `URL`) is this machine. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(hostname);
}

/**
 * Checks `raw` against the rule. When it passes, returns it as an endpoint
 * with no trailing slash. When it fails, returns which part of the rule it
 * broke, and each caller says so in its own words.
 */
export function checkAgentEndpoint(raw: string): AgentEndpointCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: 'not_a_url' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname)))
    return { ok: false, problem: 'insecure' };
  if (url.username || url.password || url.search || url.hash)
    return { ok: false, problem: 'has_extras' };
  return { ok: true, endpoint: url.href.replace(/\/+$/, '') };
}
