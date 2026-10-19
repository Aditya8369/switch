/**
 * switch-buddy's welcome names the messaging apps with their logos, drawn by
 * the chat inline in the text; a logo the chat does not know, and every other
 * image, is not drawn as one.
 */
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

import { ChatMarkdown } from '@renderer/features/chats/ui/chat-markdown';
import { buddyWelcomeMessage } from '@renderer/features/switch-buddy/buddy-welcome-message';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(markdown: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ChatMarkdown>{markdown}</ChatMarkdown>));
  // Streamdown renders after a tick.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

function logos(): string[] {
  return [...container!.querySelectorAll('[role="img"]')].map(
    (each) => each.getAttribute('aria-label') ?? ''
  );
}

describe('messaging-app logos in chat', () => {
  it('draws each app the welcome names inline, with its name beside it', async () => {
    await render(buddyWelcomeMessage({ firstName: 'Max', agentName: 'switch-buddy-max' }));
    expect(logos()).toEqual(['Slack', 'Microsoft Teams', 'Mattermost', 'Telegram']);
    for (const logo of container!.querySelectorAll('[role="img"]')) {
      expect(logo.querySelector('svg')).not.toBeNull();
      expect(logo.closest('p')).not.toBeNull();
    }
    expect(container!.textContent?.replace(/\s+/g, ' ')).toContain(
      'Slack, Microsoft Teams, Mattermost and Telegram'
    );
    expect(container!.textContent).not.toContain('switchdash');
  });

  it('draws nothing for an app it has no logo for', async () => {
    await render('Try ![Nowhere](switchdash://logo/nowhere) here.');
    expect(logos()).toEqual([]);
    expect(container!.textContent).not.toContain('switchdash');
  });
});
