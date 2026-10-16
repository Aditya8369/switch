import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { appState } from '@renderer/lib/stores/app-state';
import { WizardChromeProvider } from '@renderer/lib/ui/wizard-frame';
import { buddyIntroStore } from './buddy-intro-store';
import { MeetBuddyPage } from './meet-buddy-page';
import { openBuddyChat } from './open-buddy';

/**
 * The first run's Meet switch-buddy page, over the whole window, for someone
 * who already uses Switch: the same providers, Start with…, Skip, and the same
 * chat it ends in. "Back to the app" leaves it as it was.
 */
export const BuddyIntroFlow = observer(function BuddyIntroFlow({ serverId }: { serverId: string }) {
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const close = () => buddyIntroStore.close();
  // No workspace open on that server any more: nothing to meet the buddy in.
  useEffect(() => {
    if (workspaceId === null) buddyIntroStore.close();
  }, [workspaceId]);
  if (workspaceId === null) return null;
  return (
    <WizardChromeProvider chrome="page" exit={{ label: 'Back to the app', onExit: close }}>
      <MeetBuddyPage
        serverId={serverId}
        workspaceId={workspaceId}
        onCreated={(agent) => {
          // The chat is ready before the page goes, so the app opens on it.
          void openBuddyChat(serverId, agent).finally(close);
        }}
        onSkip={() => {
          appState.navigation.navigate('switchBuddy', { serverId });
          close();
        }}
      />
    </WizardChromeProvider>
  );
});
