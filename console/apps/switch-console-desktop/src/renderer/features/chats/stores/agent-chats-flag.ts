import { observable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import type { ServerFeatureFlags } from '@shared/core/feature-flags/feature-flags';
import { featureFlagsChangedChannel } from '@shared/events/featureFlagEvents';

const known = observable.map<string, boolean>();
const asked = new Set<string>();

function record(state: ServerFeatureFlags): void {
  if (state.fetchedAt === null) return;
  runInAction(() => known.set(state.serverId, state.flags.agent_chats));
}

events.on(featureFlagsChangedChannel, record);

/**
 * Whether a server turns agent_chats on, observable outside React. Undefined
 * until the server's flags have been read once; a server that does not send
 * the flag is off.
 */
export function agentChatsFlag(serverId: string): boolean | undefined {
  if (!asked.has(serverId)) {
    asked.add(serverId);
    void rpc.featureFlags.get(serverId).then((res) => {
      if (res?.success) record(res.data);
    });
  }
  return known.get(serverId);
}
