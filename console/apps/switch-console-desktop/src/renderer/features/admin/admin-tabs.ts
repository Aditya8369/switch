export type AdminTab = 'connectors';

export const ADMIN_TAB_LABELS = {
  connectors: 'Connectors',
} as const satisfies Record<AdminTab, string>;

/**
 * The Admin page's tabs the signed-in account may use, in order. Each tab is
 * there only for the role that may use it, so nobody is shown a control the
 * server would refuse: the workspace's connector switches are its admins'
 * (the server's operator administers every workspace).
 */
export function adminTabs(person: { administers: boolean }): AdminTab[] {
  return person.administers ? ['connectors'] : [];
}

/**
 * The tab to show: the one asked for when the person may use it, otherwise
 * the first they may. Null when they may use none.
 */
export function shownAdminTab(tabs: AdminTab[], asked: AdminTab | undefined): AdminTab | null {
  if (asked !== undefined && tabs.includes(asked)) return asked;
  return tabs[0] ?? null;
}
