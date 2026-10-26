import { MAIN_SERVICE_BASE_URL, UI_MAIN_LAYOUT_BACKUP_URL } from "../config/runtimeConfig";

export const AUTH_STORAGE_KEY = "indoor-nav.auth.v1";
export const AUTH_CHANGED_EVENT = "auth-changed";
export const SERVICE_BASE_URL = MAIN_SERVICE_BASE_URL;
export const MAIN_LAYOUT_BACKUP_SAVE_URL = UI_MAIN_LAYOUT_BACKUP_URL;
export const AUTH_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const AUTH_EXPIRED_NOTICE_KEY = "indoor-nav.auth.expired.notice";

export type AuthState = {
  loggedIn: boolean;
  username: string;
};

type StoredAuthState = AuthState & {
  expiresAtMs: number;
};

let authExpiryTimer: number | null = null;

const LOGGED_OUT_STATE: AuthState = { loggedIn: false, username: "" };

function dispatchAuthChanged(): void {
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

function clearAuthExpiryTimer(): void {
  if (authExpiryTimer !== null) {
    window.clearTimeout(authExpiryTimer);
    authExpiryTimer = null;
  }
}

function scheduleAuthExpiry(expiresAtMs: number): void {
  clearAuthExpiryTimer();
  const delay = Math.max(0, expiresAtMs - Date.now());
  authExpiryTimer = window.setTimeout(() => {
    localStorage.setItem(AUTH_EXPIRED_NOTICE_KEY, "1");
    clearAuthState("expired");
  }, delay);
}

export function getAuthState(): AuthState {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return LOGGED_OUT_STATE;

    const parsed = JSON.parse(raw) as Partial<StoredAuthState>;
    const loggedIn = Boolean(parsed?.loggedIn);
    const username = typeof parsed?.username === "string" ? parsed.username.trim() : "";
    const expiresAtMs = Number(parsed?.expiresAtMs);

    if (!loggedIn || !username || !Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      clearAuthExpiryTimer();
      return LOGGED_OUT_STATE;
    }

    scheduleAuthExpiry(expiresAtMs);
    return { loggedIn: true, username };
  } catch {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    clearAuthExpiryTimer();
    return LOGGED_OUT_STATE;
  }
}

export function setAuthState(state: AuthState): void {
  const username = state.username.trim();
  if (!state.loggedIn || !username) {
    clearAuthState();
    return;
  }

  const storedState: StoredAuthState = {
    loggedIn: true,
    username,
    expiresAtMs: Date.now() + AUTH_SESSION_TTL_MS,
  };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(storedState));
  localStorage.removeItem(AUTH_EXPIRED_NOTICE_KEY);
  scheduleAuthExpiry(storedState.expiresAtMs);
  dispatchAuthChanged();
}

export function clearAuthState(reason: "manual" | "expired" = "manual"): void {
  clearAuthExpiryTimer();
  localStorage.removeItem(AUTH_STORAGE_KEY);
  if (reason !== "expired") {
    localStorage.removeItem(AUTH_EXPIRED_NOTICE_KEY);
  }
  dispatchAuthChanged();
}

export function consumeAuthExpiredNotice(): boolean {
  const value = localStorage.getItem(AUTH_EXPIRED_NOTICE_KEY) === "1";
  if (value) {
    localStorage.removeItem(AUTH_EXPIRED_NOTICE_KEY);
  }
  return value;
}

export function initAuthSessionWatcher(): void {
  getAuthState();
}
