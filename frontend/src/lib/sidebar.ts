/**
 * Remembers whether the sidebar is collapsed. A cookie rather than localStorage, so the
 * server renders the sidebar at its saved width and the page does not shift after load.
 */
export const SIDEBAR_COOKIE = "sidebar";

const ONE_YEAR_S = 365 * 24 * 60 * 60;

export function isSidebarCollapsed(value: string | undefined): boolean {
  return value === "collapsed";
}

export function sidebarCookie(collapsed: boolean): string {
  return `${SIDEBAR_COOKIE}=${collapsed ? "collapsed" : "expanded"}; path=/; max-age=${ONE_YEAR_S}; samesite=lax`;
}
