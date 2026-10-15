import { useCallback } from 'react';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { useReloadConnectors } from './connectors-queries';

/**
 * Opens the connect modal for a service, from its card or its profile, and
 * re-reads the page however the modal ends: connecting and granting both
 * change what the page shows.
 */
export function useConnectService(serverId: string, workspaceId: string) {
  const showConnect = useShowModal('connectServiceModal');
  const reload = useReloadConnectors(workspaceId);
  return useCallback(
    (connection: ConnectionCatalogEntry, startAt: 'connect' | 'grant') =>
      showConnect({
        serverId,
        workspaceId,
        connection,
        startAt,
        onSuccess: () => void reload(),
        onClose: () => void reload(),
      }),
    [showConnect, reload, serverId, workspaceId]
  );
}
