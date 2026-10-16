import { makeAutoObservable } from 'mobx';

/**
 * Meeting switch-buddy after the first run: the server whose banner was
 * pressed, while its full-window Meet switch-buddy page is up. The page is the
 * first run's own, drawn over the app for someone who set Switch up before
 * the buddy existed.
 */
class BuddyIntroStore {
  serverId: string | null = null;
  /**
   * The person chose Skip at Meet switch-buddy since the app started: the
   * banner leaves them alone until the next launch rather than asking again
   * straight away.
   */
  skippedThisSession = false;

  constructor() {
    makeAutoObservable(this);
  }

  open(serverId: string): void {
    this.serverId = serverId;
  }

  close(): void {
    this.serverId = null;
  }

  skipped(): void {
    this.skippedThisSession = true;
  }
}

export const buddyIntroStore = new BuddyIntroStore();
