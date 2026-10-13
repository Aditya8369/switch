import { useQuery } from '@tanstack/react-query';
import { ManagedRunLocationNotice } from '@renderer/features/locations/components/add-agent-modal/managed-run-location-notice';
import { rpc } from '@renderer/lib/ipc';

/**
 * On a server with agent management, for an agent whose template says where
 * it runs as a location (this computer or an SSH host) that is not one of the
 * deployer's machines there yet: the same notice, and the same way to make it
 * one, as the New agent form gives.
 */
export function LocationMachineNotice({
  serverId,
  workspaceId,
  sshHost,
  label,
  onEnabled,
}: {
  serverId: string;
  workspaceId: string;
  /** Null for this computer. */
  sshHost: string | null;
  label: string;
  onEnabled: () => void;
}) {
  const machine = useQuery({
    queryKey: ['new-agent-machine', serverId, workspaceId, sshHost ?? 'local'],
    queryFn: () => rpc.agentMigration.newAgentMachine({ serverId, workspaceId, sshHost }),
    refetchInterval: (query) =>
      query.state.data?.management && query.state.data.blocker ? 3000 : false,
  });
  if (!machine.data) return null;
  return (
    <ManagedRunLocationNotice
      machine={machine.data}
      label={label}
      sshHost={sshHost}
      serverId={serverId}
      workspaceId={workspaceId}
      onEnabled={onEnabled}
    />
  );
}
