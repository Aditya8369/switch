import { useQuery } from '@tanstack/react-query';
import { Monitor, Server } from 'lucide-react';
import { useMemo } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

export const LOCAL_RUN_LOCATION = 'local';

/**
 * The SSH hosts an agent for `serverId` may run on. A server the Console
 * manages is reachable only from certain machines: one managed on a host is
 * reachable from this computer and from that host, one managed locally from
 * this computer only. A server the Console does not manage has no restriction.
 */
export function useAllowedHosts(serverId: string | null) {
  const { data: remoteHosts } = useQuery({
    queryKey: ['remote-hosts'],
    queryFn: () => rpc.remoteHosts.listHosts(),
  });
  const server = switchServersStore.servers.find((s) => s.id === serverId) ?? null;
  const kind = server?.managementKind ?? null;
  const host = server?.sshHost ?? null;
  return useMemo(
    () =>
      (remoteHosts ?? []).filter((h) =>
        kind === 'remote' ? h.sshHost === host : kind !== 'local'
      ),
    [remoteHosts, kind, host]
  );
}

export function runLocationLabel(
  value: string,
  hosts: readonly { sshHost: string; name: string }[]
): string {
  if (value === LOCAL_RUN_LOCATION) return 'This computer';
  return hosts.find((h) => h.sshHost === value)?.name ?? value;
}

export function RunLocationSelect({
  value,
  onChange,
  hosts,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  hosts: readonly { sshHost: string; name: string }[];
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v ?? LOCAL_RUN_LOCATION)}
      disabled={disabled}
    >
      <SelectTrigger className="w-full" aria-label="Run location">
        <SelectValue>
          {value === LOCAL_RUN_LOCATION ? (
            <Monitor className="size-4 text-foreground-muted" />
          ) : (
            <Server className="size-4 text-foreground-muted" />
          )}
          <span className="truncate">{runLocationLabel(value, hosts)}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={LOCAL_RUN_LOCATION}>
          <Monitor className="size-4 text-foreground-muted" />
          <span className="flex-1">This computer</span>
          <span className="text-xs text-foreground-muted">local</span>
        </SelectItem>
        {hosts.map((h) => (
          <SelectItem key={h.sshHost} value={h.sshHost}>
            <Server className="size-4 text-foreground-muted" />
            <span className="flex-1 truncate">{h.name}</span>
            <span className="text-xs text-foreground-muted">ssh</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The value a `machine` param holds for one of the owner's machines: its id. */
export function MachineSelect({
  value,
  onChange,
  machines,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The owner's machines on the server; null when it does not run agent management. */
  machines: readonly OwnedMachine[] | null;
  disabled?: boolean;
}) {
  if (machines === null) {
    return (
      <p className="text-xs text-foreground-muted">
        This server does not run agent management, so there is no machine to choose.
      </p>
    );
  }
  const chosen = machines.find((m) => m.id === value || m.name === value) ?? null;
  return (
    <Select value={chosen?.id ?? ''} onValueChange={(v) => onChange(v ?? '')} disabled={disabled}>
      <SelectTrigger className="w-full" aria-label="Machine">
        <SelectValue>
          <Server className="size-4 text-foreground-muted" />
          <span className="truncate">{chosen ? chosen.name : value || 'Choose a machine'}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {machines.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            <Server className="size-4 text-foreground-muted" />
            <span className="flex-1 truncate">{m.name}</span>
            <span className="text-xs text-foreground-muted">{m.state}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
