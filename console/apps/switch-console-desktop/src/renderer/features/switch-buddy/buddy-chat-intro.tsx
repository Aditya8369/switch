import { observer } from 'mobx-react-lite';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { firstNameOf } from './buddy-identity';
import { BuddyWelcome } from './buddy-welcome';

/** The welcome at the top of a chat with the person's own buddy. */
export const BuddyChatIntro = observer(function BuddyChatIntro({
  agent,
}: {
  agent: Pick<ManagedAgentView, 'serverId' | 'name'>;
}) {
  const user = switchServersStore.statusFor(agent.serverId)?.user ?? null;
  return <BuddyWelcome firstName={firstNameOf(user?.name)} agentName={agent.name} />;
});
