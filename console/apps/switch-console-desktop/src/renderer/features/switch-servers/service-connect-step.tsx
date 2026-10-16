import { CircleCheck, ExternalLink } from 'lucide-react';
import { type ReactNode, useEffect, useReducer } from 'react';
import {
  canCloseConnectFlow,
  connectFlowReducer,
  initialConnectFlow,
} from '@renderer/features/connectors/connect-flow';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
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

/**
 * Connecting a service through Switch's generic sign-in: the browser signs in
 * at the vendor, this Console takes the result back, and the person confirms
 * the account before Switch keeps it. GitHub has its own step.
 */
export function ServiceConnectStep({
  serverId,
  connection,
  onBack,
  onConnected,
}: {
  serverId: string;
  connection: ConnectionCatalogEntry;
  onBack: () => void;
  /** Moves on once the account is connected, with the warning Switch gave. */
  onConnected?: (warning: string | null) => void;
}) {
  return (
    <ServiceSignInStep
      serverId={serverId}
      connection={connection}
      onBack={onBack}
      readyContent={() => (
        <p className="text-sm text-foreground-muted">
          Confirm this is the {connection.name} account you want to connect to Switch.
        </p>
      )}
      confirmLabel={(account) => `Connect ${account}`}
      onConnected={async (warning) => onConnected?.(warning)}
    />
  );
}

/**
 * The sign-in, with what the signed-in screen shows under the account and
 * what its one button says chosen by the caller. The button confirms the
 * account with Switch, then hands over to `onConnected`, which the dialog
 * waits for before it shows the account connected.
 */
export function ServiceSignInStep({
  serverId,
  connection,
  onBack,
  readyContent,
  confirmLabel,
  onConnected,
}: {
  serverId: string;
  connection: ConnectionCatalogEntry;
  onBack: () => void;
  /** Under "Signed in as", once the browser has finished; `busy` while confirming. */
  readyContent: (busy: boolean) => ReactNode;
  confirmLabel: (account: string) => string;
  onConnected: (warning: string | null) => Promise<void>;
}) {
  const service = connection.slug;
  const [state, dispatch] = useReducer(
    connectFlowReducer,
    connection.status === 'connected',
    initialConnectFlow
  );
  const { connected, flowId, flow, busy, warning, error } = state;
  const closable = canCloseConnectFlow(state);
  useCloseGuard(!closable);
  useEffect(() => {
    if (!flowId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await rpc.switchServers.getServiceFlow(serverId, service, flowId);
        if (!alive) return;
        dispatch({
          type: 'polled',
          flow: result,
          failure: `Signing in to ${connection.name} failed. Cancel and try again.`,
        });
        if (result.status !== 'ready' && result.status !== 'failed')
          timer = setTimeout(() => void poll(), 2000);
      } catch (cause) {
        if (alive)
          dispatch({
            type: 'poll_failed',
            error: failureText(cause, `Could not check the ${connection.name} sign-in.`),
          });
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [serverId, service, flowId, connection.name]);
  const fallback = `Could not update the ${connection.name} connection.`;
  const start = async () => {
    dispatch({ type: 'act' });
    try {
      dispatch({
        type: 'started',
        flowId: await rpc.switchServers.startServiceConnection(serverId, service),
      });
    } catch (cause) {
      dispatch({ type: 'failed', error: failureText(cause, fallback) });
    }
  };
  const confirm = async (id: string) => {
    dispatch({ type: 'act' });
    let result: { warning: string | null };
    try {
      result = await rpc.switchServers.confirmServiceConnection(serverId, service, id);
    } catch (cause) {
      dispatch({ type: 'confirm_failed', cause, error: failureText(cause, fallback) });
      return;
    }
    try {
      await onConnected(result.warning);
    } finally {
      dispatch({ type: 'confirmed', warning: result.warning });
    }
  };
  const cancel = async (id: string) => {
    dispatch({ type: 'act' });
    try {
      await rpc.switchServers.cancelServiceConnection(serverId, service, id);
      dispatch({ type: 'cancelled' });
    } catch (cause) {
      dispatch({ type: 'cancel_failed', cause, error: failureText(cause, fallback) });
    }
  };
  const disconnect = async () => {
    dispatch({ type: 'act' });
    try {
      const result = await rpc.switchServers.disconnectService(serverId, service);
      dispatch({ type: 'disconnected', warning: result.warning });
    } catch (cause) {
      dispatch({ type: 'failed', error: failureText(cause, fallback) });
    }
  };
  const needsReconnect =
    connection.status === 'needs_reauthorization' || connection.status === 'error';
  return (
    <>
      <DialogHeader showCloseButton={closable}>
        <DialogTitle>
          {connected && !flowId ? `${connection.name} connected` : `Connect ${connection.name}`}
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        {flowId ? (
          flow?.status === 'ready' ? (
            <>
              <p className="flex items-center gap-2 text-sm">
                <CircleCheck className="size-5 text-foreground-success" />
                Signed in as <strong>{flow.account}</strong>
              </p>
              {readyContent(busy)}
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm">
              <Spinner /> Finish signing in in your browser, then return here.
            </p>
          )
        ) : (
          <>
            <p className="text-sm text-foreground-muted">{connection.description}</p>
            <p className="text-sm text-foreground-muted">
              {connected
                ? `Agents you turn ${connection.name} on for act as you there, with what you allowed when you signed in.`
                : `You sign in at ${connection.name}, and allow what Switch asks for. Agents you then turn ${connection.name} on for act as you there.`}
            </p>
            {needsReconnect && !connected && (
              <p className="text-sm text-destructive">
                Switch can no longer use your {connection.name} sign-in. Connect again.
              </p>
            )}
            {connected && (
              <p className="text-xs text-foreground-muted">
                Disconnecting removes the sign-in Switch keeps, and every agent's access to{' '}
                {connection.name}.
              </p>
            )}
          </>
        )}
        {connection.unavailable_reason && (
          <p className="text-sm text-foreground-muted">{connection.unavailable_reason}</p>
        )}
        {warning && (
          <p role="status" className="rounded-md border p-3 text-sm text-foreground-muted">
            {warning}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        {flowId ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void cancel(flowId)}>
              Cancel
            </Button>
            {flow?.status === 'ready' && (
              <Button disabled={busy} onClick={() => void confirm(flowId)}>
                {busy && <Spinner />}
                {confirmLabel(flow.account ?? connection.name)}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onBack} disabled={busy}>
              Back
            </Button>
            {connected && (
              <Button variant="ghost" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </Button>
            )}
            {(!connected || error) && (
              <Button disabled={busy || !connection.connectable} onClick={() => void start()}>
                Connect {connection.name} <ExternalLink className="size-4" />
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}
