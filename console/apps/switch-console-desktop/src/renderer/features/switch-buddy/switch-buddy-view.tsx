import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { BuddyAvatar } from './buddy-avatar';
import { BUDDY_DISPLAY_NAME, firstNameOf, isBuddy } from './buddy-identity';
import { BuddyWelcome } from './buddy-welcome';
import { openBuddyChat } from './open-buddy';

type SwitchBuddyParams = { serverId: string };

const SwitchBuddyTitlebar = () => (
  <Titlebar
    leftClassName="min-w-0"
    leftSlot={
      <div className="flex items-center gap-2 pr-2 text-sm">
        <BuddyAvatar size={18} />
        <span>{BUDDY_DISPLAY_NAME}</span>
      </div>
    }
  />
);

/**
 * switch-buddy before it exists: its welcome, and in place of the message box
 * a way to connect the AI provider it needs, since Switch creates no agent
 * until one is ready. Once the person has a buddy this opens its chat instead.
 */
const SwitchBuddyPanel = observer(function SwitchBuddyPanel() {
  const { params } = useParams('switchBuddy');
  const { serverId } = params;
  const managed = useManagedAgents(serverId);
  const buddy = managed.data?.find(isBuddy) ?? null;
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const user = switchServersStore.statusFor(serverId)?.user ?? null;

  useEffect(() => {
    if (buddy) void openBuddyChat(serverId, buddy);
  }, [buddy, serverId]);

  const connect = () => {
    if (workspaceId === null) return;
    showModal('buddySetupModal', {
      serverId,
      workspaceId,
      onSuccess: (agent) => void openBuddyChat(serverId, agent),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[860px] px-5 py-6">
          <BuddyWelcome firstName={firstNameOf(user?.name)} agentName={null} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[860px] px-5 pb-5">
        <button
          type="button"
          onClick={connect}
          disabled={workspaceId === null}
          className="w-full rounded-full border border-border bg-background px-5 py-3 text-left text-sm text-foreground shadow-sm hover:bg-[var(--sel-soft)] disabled:opacity-60"
        >
          Connect an AI provider to chat with switch-buddy
        </button>
        {workspaceId === null && (
          <p className="mt-2 text-xs text-foreground-muted">
            Open a workspace on this server first.
          </p>
        )}
      </div>
    </div>
  );
});

export const switchBuddyView = {
  WrapView: ({ children }: SwitchBuddyParams & { children: React.ReactNode }) => <>{children}</>,
  TitlebarSlot: SwitchBuddyTitlebar,
  MainPanel: SwitchBuddyPanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof SwitchBuddyParams, unknown>>;
    if (typeof value.serverId !== 'string')
      return { ok: false, redirect: 'home', discardParams: true };
    return { ok: true };
  },
} satisfies ViewDefinition<SwitchBuddyParams>;
