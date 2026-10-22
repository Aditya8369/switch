import type { VisibilityPair } from "../../data/visibility";

/** Whether a user may write to a room, as the server decides it (`can(...,
 * "write", room)` in `switch_core.authz`): its owner, a tenant admin, or
 * anyone when the room is publicly writable. */
export function canWriteRoom(
  room: VisibilityPair & { owner_id: string | null },
  userId: string | null | undefined,
  canAdminTenant: boolean,
): boolean {
  if (!userId) return false;
  return (
    canAdminTenant ||
    (room.owner_id !== null && room.owner_id === userId) ||
    room.write_visibility === "public"
  );
}
