/**
 * Setting up a Slack or Discord app of your own: the guide reads the workspace
 * or server from the pasted tokens and fills it in, once the platform says the
 * tokens work.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const workspaces = vi.hoisted(() => ({
  slackOwnAppSetup: vi.fn(),
  checkSlackTokens: vi.fn(),
  checkDiscordToken: vi.fn(),
}));
const openExternalUrl = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/ipc', () => ({ rpc: { workspaces } }));
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }));

import { OwnAppGuide } from '@renderer/features/switch-servers/own-app-guide';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function render(
  platform: 'slack' | 'discord',
  config: Record<string, string>,
  setField: (key: string, value: string | null) => void
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <OwnAppGuide platform={platform} workspaceId="ws-1" config={config} setField={setField} />
      </QueryClientProvider>
    )
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 900)));

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(name));
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

describe('the Slack guide', () => {
  it('opens Slack with the app filled in', async () => {
    workspaces.slackOwnAppSetup.mockResolvedValue({ createUrl: 'https://api.slack.com/apps?x' });
    await render('slack', {}, () => {});
    await settle();
    await act(async () => button('Create the Slack app').click());
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://api.slack.com/apps?x',
      expect.any(String)
    );
  });

  it('fills in the workspace once both tokens work', async () => {
    workspaces.slackOwnAppSetup.mockResolvedValue({ createUrl: 'https://api.slack.com/apps?x' });
    workspaces.checkSlackTokens.mockResolvedValue({
      workspaceId: 'T123',
      workspaceName: 'Acme',
      botName: 'agent_switch',
    });
    const setField = vi.fn();
    await render('slack', { bot_token: 'xoxb-1', app_token: 'xapp-1' }, setField);
    await settle();
    await settle();
    expect(workspaces.checkSlackTokens).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
    });
    expect(setField).toHaveBeenLastCalledWith('workspace_id', 'T123');
    expect(document.body.textContent).toContain('Both tokens work, for the Acme workspace');
  });
});

describe('the Discord guide', () => {
  it('says which intent is off, and fills in the server once the bot is in one', async () => {
    workspaces.checkDiscordToken.mockResolvedValue({
      applicationId: '42',
      name: 'Acme Switch',
      messageContent: true,
      serverMembers: true,
      inviteUrl: 'https://discord.com/oauth2/authorize?client_id=42',
      servers: [{ id: '7', name: 'Acme' }],
    });
    const setField = vi.fn();
    await render('discord', { bot_token: 'token' }, setField);
    await settle();
    await settle();
    expect(setField).toHaveBeenLastCalledWith('guild_id', '7');
    expect(document.body.textContent).toContain('Added to Acme');
    await act(async () => button('Add the bot to your server').click());
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://discord.com/oauth2/authorize?client_id=42',
      expect.any(String)
    );
  });

  it('holds back the server while an intent is off', async () => {
    workspaces.checkDiscordToken.mockResolvedValue({
      applicationId: '42',
      name: 'Acme Switch',
      messageContent: false,
      serverMembers: true,
      inviteUrl: 'https://discord.com/oauth2/authorize?client_id=42',
      servers: [{ id: '7', name: 'Acme' }],
    });
    const setField = vi.fn();
    await render('discord', { bot_token: 'token' }, setField);
    await settle();
    await settle();
    expect(setField).not.toHaveBeenCalledWith('guild_id', '7');
    expect(button('Add the bot to your server').disabled).toBe(true);
  });
});
