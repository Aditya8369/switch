import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { disconnectCopy } from './connector-copy';
import { useConnectionAgents } from './connectors-queries';

/**
 * Disconnecting a service from its profile, after saying which of the
 * person's agents lose it. A warning Switch answers with stays on screen until
 * the person closes the dialog.
 */
export function DisconnectServiceDialog({
  serverId,
  workspaceId,
  connection,
  onSuccess,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
} & BaseModalProps) {
  const agents = useConnectionAgents(workspaceId, connection.slug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useCloseGuard(busy);
  // Null where the server cannot list them, or they could not be read: every agent then.
  const granted = agents.data?.filter((agent) => agent.granted).map((agent) => agent.name) ?? null;
  const copy = disconnectCopy(connection, granted);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result =
        connection.slug === 'github'
          ? await rpc.switchServers.disconnectGitHub(serverId)
          : await rpc.switchServers.disconnectService(serverId, connection.slug);
      if (result.warning) {
        setWarning(result.warning);
        setDone(true);
      } else onSuccess(undefined);
    } catch (cause) {
      setError(failureText(cause, `Could not disconnect ${connection.name}.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>{done ? `${connection.name} disconnected` : copy.title}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        {done ? (
          <p role="status" className="rounded-md border p-3 text-sm text-foreground-muted">
            {warning}
          </p>
        ) : (
          <>
            {agents.isPending && (
              <p className="flex items-center gap-2 text-sm">
                <Spinner /> Checking which of your agents use {connection.name}…
              </p>
            )}
            {agents.isError && (
              <p role="alert" className="text-sm text-destructive">
                {failureText(
                  agents.error,
                  `Could not check which of your agents use ${connection.name}.`
                )}
              </p>
            )}
            {!agents.isPending &&
              copy.lines.map((line) => (
                <p key={line} className="text-sm">
                  {line}
                </p>
              ))}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        {done ? (
          <Button onClick={() => onSuccess(undefined)}>Done</Button>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || agents.isPending}
              onClick={() => void disconnect()}
            >
              {busy && <Spinner />}
              Disconnect
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
