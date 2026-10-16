import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { useCurrentViewId } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import { BuddyAvatar } from './buddy-avatar';
import { isBuddy } from './buddy-identity';
import { buddyIntroStore } from './buddy-intro-store';
import { reportBuddyStep } from './buddy-telemetry';

const DISMISSED_KEY = (workspaceId: string) => `switchBuddy.bannerDismissed.${workspaceId}`;

/**
 * switch-buddy, introduced to someone who set Switch up before it existed: on
 * a server that offers it, in a workspace where they have none. "Meet
 * switch-buddy" opens the first run's own Meet page; "Not now" puts the banner
 * away for this workspace, and the sidebar's entry still leads to the buddy.
 */
export const BuddyBanner = observer(function BuddyBanner() {
  const serverId = switchServersStore.activeServerId;
  const flags = useFeatureFlags(serverId);
  const agents = useManagedAgents(serverId);
  const workspaceId = serverId ? workspacesStore.idOnServerInScope(serverId) : null;
  const [dismissedNow, setDismissedNow] = useState<string | null>(null);
  // The buddy's own page already offers to set it up.
  const onBuddyPage = useCurrentViewId() === 'switchBuddy';
  if (
    !BUILD_FEATURE_FLAGS.onboarding ||
    onBuddyPage ||
    buddyIntroStore.skippedThisSession ||
    serverId === null ||
    workspaceId === null ||
    !flags.switch_buddy ||
    !flags.agent_management ||
    !agents.data ||
    agents.data.some(isBuddy) ||
    dismissedNow === workspaceId ||
    localStorage.getItem(DISMISSED_KEY(workspaceId)) !== null
  )
    return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY(workspaceId), new Date().toISOString());
    setDismissedNow(workspaceId);
    reportBuddyStep('banner_dismissed', null);
  };
  const meet = () => {
    reportBuddyStep('banner_opened', null);
    buddyIntroStore.open(serverId);
  };

  return (
    <div
      role="region"
      aria-label="Meet switch-buddy"
      className="flex shrink-0 items-center gap-3 border-b-[0.5px] border-border bg-[var(--sel-soft)] px-4 py-2.5"
    >
      <BuddyAvatar size={22} shape="round" />
      <p className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        <span className="font-medium">Meet switch-buddy</span>, your assistant in Switch. It creates
        agents and rooms for you, and answers anything about Switch.
      </p>
      <Button variant="ghost" size="sm" onClick={dismiss}>
        Not now
      </Button>
      <Button size="sm" onClick={meet}>
        Meet switch-buddy
      </Button>
    </div>
  );
});
