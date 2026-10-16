import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { OnboardingSurface } from '@renderer/lib/ui/wizard-frame';
import { BuddyAvatar } from './buddy-avatar';
import { firstNameOf, isBuddy } from './buddy-identity';
import { BuddyIntroLines } from './buddy-intro-lines';
import { buddyIntroStore } from './buddy-intro-store';
import { openBuddyChat } from './open-buddy';

/**
 * switch-buddy, introduced over the whole window to someone who already uses
 * Switch, the way the first run introduces it, with one way on: its page. That
 * is its chat when it exists, else the page where an AI provider is connected
 * to start it. "Back to the app" leaves everything as it was.
 */
export const BuddyIntroFlow = observer(function BuddyIntroFlow({ serverId }: { serverId: string }) {
  const user = switchServersStore.statusFor(serverId)?.user ?? null;
  const buddy = useManagedAgents(serverId).data?.find(isBuddy) ?? null;
  const [opening, setOpening] = useState(false);
  const close = () => buddyIntroStore.close();

  const meet = async () => {
    setOpening(true);
    // The destination is ready before the page goes, so the app opens on it.
    if (buddy) await openBuddyChat(serverId, buddy);
    else appState.navigation.navigate('switchBuddy', { serverId });
    close();
  };

  return (
    <OnboardingSurface
      exit={{ label: 'Back to the app', onExit: close }}
      footer={
        <Button onClick={() => void meet()} disabled={opening}>
          {opening && <Spinner className="size-3.5" />}
          Meet switch-buddy
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <BuddyAvatar size={80} shape="tile" />
        <h1 className="mt-2 text-2xl font-semibold">Meet switch-buddy</h1>
        <p className="text-sm text-foreground-muted">Your first AI assistant in Switch</p>
      </div>
      <BuddyIntroLines firstName={firstNameOf(user?.name)} />
    </OnboardingSurface>
  );
});
