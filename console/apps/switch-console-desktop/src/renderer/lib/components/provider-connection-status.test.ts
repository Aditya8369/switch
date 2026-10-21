import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => ({ data: undefined as unknown, error: null as unknown }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: query.data, error: query.error, isFetching: false }),
  useMutation: () => ({ isSuccess: false, error: null, mutate: () => {} }),
}));
vi.mock('@shared/core/providers/agent-provider-registry', () => ({
  getProvider: () => ({ name: 'Claude Code', loginCommand: 'claude auth login' }),
}));

const { ProviderConnectionStatus } = await import('./provider-connection-status');

const render = (compact: boolean) =>
  renderToStaticMarkup(
    React.createElement(ProviderConnectionStatus, {
      providerId: 'claude',
      sshHost: 'box',
      dir: '',
      compact,
    })
  );

const NOT_SET_UP =
  'Switch is not set up on box yet, so Claude Code cannot be checked there. Re-check the host on its page, or start an agent on it.';

beforeEach(() => {
  query.data = undefined;
  query.error = null;
});

it('gives the compact status the reason a sign-in could not be checked', () => {
  query.data = { installed: true, status: 'unknown', message: NOT_SET_UP, models: [] };

  const html = render(true);

  expect(html).toContain('Sign-in not verified');
  expect(html).toContain(`title="${NOT_SET_UP}"`);
});

it('does not suggest signing in when the check could not run', () => {
  query.data = { installed: true, status: 'unknown', message: NOT_SET_UP, models: [] };

  const html = render(false);

  expect(html).toContain(NOT_SET_UP);
  expect(html).not.toContain('claude auth login');
});

it('suggests signing in when the CLI says it is signed out', () => {
  query.data = { installed: true, status: 'unauthenticated', message: 'Signed out', models: [] };

  expect(render(false)).toContain('claude auth login');
});

it('gives no reason when signed in', () => {
  query.data = { installed: true, status: 'authenticated', message: 'ok', models: [] };

  const html = render(true);

  expect(html).toContain('Signed in');
  expect(html).not.toContain('title=');
});
