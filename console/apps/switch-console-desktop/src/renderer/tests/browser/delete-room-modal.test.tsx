/**
 * The delete dialog says what will become of a bridged room's channel on its
 * own platform, and reports a channel the server could not retire.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRoomDetail = vi.hoisted(() => vi.fn());
const deleteRoom = vi.hoisted(() => vi.fn());
const summary = vi.hoisted(() => ({ current: { bridgeType: 'slack', agentCount: 0 } }));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { workspaces: { getRoomDetail } },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomSummaryById: () => summary.current,
    deleteRoom,
  },
}));

import { DeleteRoomModal } from '@renderer/features/switch-rooms/DeleteRoomModal';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  getRoomDetail.mockReset();
  deleteRoom.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(bridgeType: string, channelOnDelete?: string | null) {
  summary.current = { bridgeType, agentCount: 0 };
  getRoomDetail.mockResolvedValue(
    channelOnDelete === undefined ? { bridgeType } : { bridgeType, channelOnDelete }
  );
  const onSuccess = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open>
          <DialogContent>
            <DeleteRoomModal
              workspaceId="ws-1"
              roomId="room-1"
              roomName="standup"
              onSuccess={onSuccess}
              onClose={() => {}}
            />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>
    )
  );
  await vi.waitFor(() => expect(getRoomDetail).toHaveBeenCalled());
  await act(async () => {});
  return onSuccess;
}

function text(): string {
  return document.body.textContent ?? '';
}

function button(label: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    label.test(b.textContent ?? '')
  );
  if (!found) throw new Error(`no button matching ${label}`);
  return found;
}

describe('the delete dialog before confirming', () => {
  it('says a Slack channel will be archived', async () => {
    await render('slack', 'archived');

    await vi.waitFor(() => expect(text()).toContain('Its Slack channel will be archived.'));
    expect(text()).not.toContain('channel will be deleted');
  });

  it('says a Teams channel stays and must be removed in Teams', async () => {
    await render('teams', 'kept');

    await vi.waitFor(() =>
      expect(text()).toContain(
        'Its Microsoft Teams channel stays in Microsoft Teams; remove it there.'
      )
    );
  });

  it('falls back to "may remain" for a server that does not say', async () => {
    await render('slack');

    await vi.waitFor(() =>
      expect(text()).toContain('The Slack channel may remain after the room is deleted.')
    );
  });
});

describe('the delete dialog after confirming', () => {
  it('closes when the channel was retired', async () => {
    const onSuccess = await render('slack', 'archived');
    deleteRoom.mockResolvedValue({ outcome: 'archived', reason: null });

    await act(async () => button(/^Delete room/).click());

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('asks for a channel Slack would not archive to be archived by hand', async () => {
    const onSuccess = await render('slack', 'archived');
    deleteRoom.mockResolvedValue({
      outcome: 'failed',
      reason: 'The Switch app is no longer in this Slack channel, so it cannot archive it',
    });

    await act(async () => button(/^Delete room/).click());

    await vi.waitFor(() => expect(text()).toContain('Archive it in Slack by hand.'));
    expect(onSuccess).not.toHaveBeenCalled();
    await act(async () => button(/^Close$/).click());
    expect(onSuccess).toHaveBeenCalled();
  });
});
