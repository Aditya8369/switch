export type WorkspaceNavView =
  | 'server'
  | 'serverAgents'
  | 'serverRooms'
  | 'connectors'
  | 'templates'
  | 'managedServer';

/**
 * The active server's destinations, in order. Connectors follows Your Rooms
 * only where the server has service connections on: with them off its routes
 * are not mounted, so there is nothing to show. Server is only for a server
 * this Console runs: the others are run by someone else, and there is nothing
 * here to start, stop or update.
 */
export function workspaceNavViews(server: {
  managed: boolean;
  serviceConnections: boolean;
}): WorkspaceNavView[] {
  return [
    'server',
    'serverAgents',
    'serverRooms',
    ...(server.serviceConnections ? (['connectors'] as const) : []),
    'templates',
    ...(server.managed ? (['managedServer'] as const) : []),
  ];
}
