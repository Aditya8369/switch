import { describe, expect, it } from 'vitest';
import { checkAgentEndpoint, isLoopbackHostname } from './agent-endpoint';

/**
 * The rule's one table. The agents controller's `normalizeServerUrl` and
 * Switch Console's server-address resolver call `checkAgentEndpoint` rather
 * than restating it, and their own tests check only that they delegate.
 */
const AGENT_ENDPOINT_CASES: ReadonlyArray<{
  raw: string;
  expected: ReturnType<typeof checkAgentEndpoint>;
}> = [
  {
    raw: 'https://switch-api.example.com',
    expected: { ok: true, endpoint: 'https://switch-api.example.com' },
  },
  {
    raw: 'https://switch-api.example.com/',
    expected: { ok: true, endpoint: 'https://switch-api.example.com' },
  },
  {
    raw: 'https://switch.example.com:8443',
    expected: { ok: true, endpoint: 'https://switch.example.com:8443' },
  },
  { raw: 'http://localhost:8000', expected: { ok: true, endpoint: 'http://localhost:8000' } },
  { raw: 'http://127.0.0.1:8000/', expected: { ok: true, endpoint: 'http://127.0.0.1:8000' } },
  { raw: 'http://[::1]:8000', expected: { ok: true, endpoint: 'http://[::1]:8000' } },
  { raw: 'http://switch-api.example.com', expected: { ok: false, problem: 'insecure' } },
  { raw: 'http://10.0.0.5:8000', expected: { ok: false, problem: 'insecure' } },
  { raw: 'ftp://switch-api.example.com', expected: { ok: false, problem: 'insecure' } },
  { raw: 'https://user:pw@switch-api.example.com', expected: { ok: false, problem: 'has_extras' } },
  { raw: 'https://switch-api.example.com/?a=1', expected: { ok: false, problem: 'has_extras' } },
  { raw: 'https://switch-api.example.com/#x', expected: { ok: false, problem: 'has_extras' } },
  { raw: 'switch-api.example.com', expected: { ok: false, problem: 'not_a_url' } },
  { raw: '', expected: { ok: false, problem: 'not_a_url' } },
];

describe('checkAgentEndpoint', () => {
  it.each(AGENT_ENDPOINT_CASES)('$raw', ({ raw, expected }) => {
    expect(checkAgentEndpoint(raw)).toEqual(expected);
  });
});

describe('isLoopbackHostname', () => {
  it('names this machine only', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('localhost.example.com')).toBe(false);
  });
});
