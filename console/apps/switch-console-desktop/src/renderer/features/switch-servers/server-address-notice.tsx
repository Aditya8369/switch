import { Info } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { notifyPropagation } from './AddServerModal';
import {
  type AddressNotice,
  cancelNotice,
  confirmNotice,
  dismissNotice,
  noticeFor,
  savingNotice,
} from './server-address-notice-state';
import { switchServersStore } from './switch-servers-store';

/**
 * Says so when a saved server now advertises a different agent address than
 * the one saved for it, and offers to switch. It never switches by itself:
 * the person confirms, because saving re-points every agent on the server and
 * restarts the agents this computer runs for it.
 */
export const ServerAddressNotice = observer(function ServerAddressNotice({
  server,
}: {
  server: SwitchServer;
}) {
  const [notice, setNotice] = useState<AddressNotice>({ kind: 'hidden' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setNotice({ kind: 'hidden' });
    rpc.switchServers.checkServerAddresses(server.id).then(
      (check) => {
        if (current) setNotice(noticeFor(server.id, check));
      },
      // A check that could not be made is no reason to bother anyone.
      () => {}
    );
    return () => {
      current = false;
    };
  }, [server.id, server.apiUrl]);

  if (notice.kind === 'hidden') return null;

  const accept = async () => {
    setNotice(savingNotice(notice));
    setError(null);
    const result = await switchServersStore.updateServer(
      server.id,
      server.name,
      server.gatewayUrl,
      notice.advertisedApiUrl
    );
    if (!result) {
      // Back to the confirmation, so it can be tried again or cancelled.
      setNotice({ ...notice, kind: 'confirming' });
      setError(switchServersStore.errorText ?? 'Could not save the new agent address.');
      return;
    }
    notifyPropagation(result.propagation);
    setNotice({ kind: 'hidden' });
  };

  return (
    <Alert>
      <Info className="size-4" />
      <AlertTitle>This server says agents connect somewhere else now</AlertTitle>
      <AlertDescription>
        <p>
          Your agents use <code>{notice.savedApiUrl}</code>, but this server says agents connect to{' '}
          <code>{notice.advertisedApiUrl}</code>.
        </p>
        {notice.kind === 'offering' ? (
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => setNotice(confirmNotice(notice))}>
              Use suggested address
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setNotice(dismissNotice(server.id, notice))}
            >
              Dismiss
            </Button>
          </div>
        ) : (
          <>
            <p className="mt-2">
              Switching points every agent on this server at the new address and restarts the agents
              this computer runs for it.
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={notice.kind === 'saving'} onClick={() => void accept()}>
                {notice.kind === 'saving' ? 'Switching…' : 'Switch agents to it'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={notice.kind === 'saving'}
                onClick={() => setNotice(cancelNotice(notice))}
              >
                Cancel
              </Button>
            </div>
          </>
        )}
        {error && <p className="mt-2 text-destructive">{error}</p>}
      </AlertDescription>
    </Alert>
  );
});
