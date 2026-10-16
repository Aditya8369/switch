/**
 * GitHub's own step, opened from the Connectors page: it offers to connect,
 * none of the setup wizard's ways onward, and a way back; and it says when an
 * organization's single sign-on hides the installation.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const switchServers = vi.hoisted(() => ({
  getGitHubConnection: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { ManagedGitHubStep } from '@renderer/features/switch-servers/managed-github-step';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  switchServers.getGitHubConnection.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(onBack: () => void): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>
          <ManagedGitHubStep serverId="server" onBack={onBack} />
        </DialogContent>
      </Dialog>
    )
  );
}

function button(name: RegExp, within: ParentNode = document): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
}

it('offers to connect GitHub, and a way back', async () => {
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'not_connected',
    install_url: 'https://github.com/apps/example/installations/new',
  });
  const onBack = vi.fn();
  await render(onBack);

  await vi.waitFor(() => expect(button(/^connect github\s*$/i, dialog())).toBeDefined());
  expect(switchServers.getGitHubConnection).toHaveBeenCalledWith('server');
  expect(button(/set up later/i, dialog())).toBeUndefined();
  expect(button(/continue to agent/i, dialog())).toBeUndefined();

  await act(async () => button(/^back$/i, dialog())!.click());
  expect(onBack).toHaveBeenCalledOnce();
});

it("says when an organization's single sign-on hides its installation", async () => {
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'connected',
    login: 'example-user',
    install_url: 'https://github.com/apps/example/installations/new',
    installations: [],
    sso_hidden_organizations: [21955855],
  });
  await render(() => {});

  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(
      /single sign-on hides its installation/
    )
  );
});
