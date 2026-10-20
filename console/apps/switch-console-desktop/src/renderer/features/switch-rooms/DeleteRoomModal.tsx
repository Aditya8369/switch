import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { channelCleanupText, channelOnDeleteText } from './room-delete-wording';

type Props = BaseModalProps<void> & {
  workspaceId: string;
  roomId: string;
  roomName: string;
};

/**
 * Confirm deleting a room.
 *
 * Deleting is not leaving: the room stops existing for everyone in it, and on a
 * bridged room its channel is retired as far as the platform allows — archived,
 * deleted, left by the bot, or left where it is. Both are things you cannot find
 * out by trying, so they are said before rather than reported after: the
 * platform's outcome comes from the room's own detail (`channelOnDelete`).
 *
 * A channel the server could not retire does not stop the room being deleted,
 * so that one is reported after, in place of closing, with what is left to do
 * by hand.
 */
export const DeleteRoomModal = observer(function DeleteRoomModal({
  workspaceId,
  roomId,
  roomName,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cleanup, setCleanup] = useState<string | null>(null);
  // Once the room is gone only Close may end this, so the caller still hears it
  // succeeded and can leave the deleted room's page.
  useCloseGuard(cleanup !== null);

  const room = switchRoomsStore.roomSummaryById(roomId);
  const platform = room?.bridgeType ? bridgePlatformLabel(room.bridgeType) : null;
  const agentCount = room?.agentCount ?? 0;
  // The same key the room's settings page reads under, so an open page answers
  // at once.
  const detail = useQuery({
    queryKey: ['remote-room-detail', workspaceId, roomId],
    queryFn: () => rpc.workspaces.getRoomDetail({ workspaceId, roomId }),
    enabled: platform !== null,
  });
  // Unread or unreadable, the outcome is unknown, which has wording of its own.
  const planned = detail.data?.channelOnDelete;
  const channelText = platform && !detail.isPending ? channelOnDeleteText(platform, planned) : null;

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    setCloseGuard(true);
    setError(null);
    try {
      const channel = await switchRoomsStore.deleteRoom(workspaceId, roomId);
      const notice = platform ? channelCleanupText(platform, planned, channel) : null;
      if (notice) {
        setCleanup(notice);
        setIsDeleting(false);
      } else {
        onSuccess();
      }
    } catch (cause) {
      setError(failureText(cause, 'Could not delete the room.'));
      setIsDeleting(false);
    } finally {
      setCloseGuard(false);
    }
  }, [workspaceId, roomId, platform, planned, onSuccess, setCloseGuard]);

  if (cleanup) {
    return (
      <>
        <DialogHeader showCloseButton={false}>
          <div className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-amber-500" />
            <DialogTitle>“{roomName}” was deleted</DialogTitle>
          </div>
        </DialogHeader>
        <DialogContentArea className="space-y-3 pt-0">
          <p className="text-sm text-foreground-muted">{cleanup}</p>
        </DialogContentArea>
        <DialogFooter>
          <Button onClick={() => onSuccess()}>Close</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-red-500" />
          <DialogTitle>Delete “{roomName}”?</DialogTitle>
        </div>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <p className="text-sm text-foreground-muted">
          This deletes the room for everyone in it, along with its conversation. It can’t be undone.
        </p>
        {channelText && <p className="text-sm text-foreground-muted">{channelText}</p>}
        {agentCount > 0 && (
          <p className="text-sm text-foreground-muted">
            {agentCount} {agentCount === 1 ? 'agent leaves' : 'agents leave'} the room. The agents
            themselves are kept.
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isDeleting}>
          Cancel
        </Button>
        <ConfirmButton
          variant="destructive"
          onClick={() => void handleDelete()}
          disabled={isDeleting}
        >
          {isDeleting ? 'Deleting…' : 'Delete room'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
