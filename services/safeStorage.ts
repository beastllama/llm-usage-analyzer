// Browser storage can be blocked, full, or missing (privacy settings, sandboxed frames).
// The app must still work, so every access goes through here and never throws.

const wrap = (getStore: () => Storage) => ({
  get(key: string): string | null {
    try { return getStore().getItem(key); } catch { return null; }
  },
  /** Returns false when the value could not be saved. */
  set(key: string, value: string): boolean {
    try { getStore().setItem(key, value); return true; } catch { return false; }
  },
  remove(key: string): void {
    try { getStore().removeItem(key); } catch { /* nothing to do */ }
  },
});

export const safeLocal = wrap(() => window.localStorage);
export const safeSession = wrap(() => window.sessionStorage);
