import { getAuthState } from "../src/utils/auth";
import {
  SANDBOX_SERVICE_BASE_URL as CONFIGURED_SANDBOX_SERVICE_BASE_URL,
  SANDBOX_UI_MAIN_LAYOUT_BACKUP_URL,
} from "../src/config/runtimeConfig";

export const SANDBOX_AUTH_STORAGE_KEY = "indoor-nav.sandbox.auth.v1";
export const SANDBOX_AUTH_CHANGED_EVENT = "sandbox-auth-changed";
export const SANDBOX_SERVICE_BASE_URL = CONFIGURED_SANDBOX_SERVICE_BASE_URL;
export const SANDBOX_MAIN_LAYOUT_BACKUP_SAVE_URL = SANDBOX_UI_MAIN_LAYOUT_BACKUP_URL;

export type SandboxAuthState = {
  loggedIn: boolean;
  username: string;
  authorization: string;
};

type SandboxLoginResult = {
  ok: boolean;
  error?: string;
  username?: string;
  authorization?: string;
};

const LOGGED_OUT_STATE: SandboxAuthState = {
  loggedIn: false,
  username: "",
  authorization: "",
};

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function shouldUseLiveAuthForSandbox(): boolean {
  if (!SANDBOX_SERVICE_BASE_URL || !isAbsoluteUrl(SANDBOX_SERVICE_BASE_URL)) {
    return true;
  }
  try {
    return new URL(SANDBOX_SERVICE_BASE_URL).origin === window.location.origin;
  } catch {
    return false;
  }
}

function dispatchSandboxAuthChanged(): void {
  window.dispatchEvent(new Event(SANDBOX_AUTH_CHANGED_EVENT));
}

export function getSandboxAuthState(): SandboxAuthState {
  const liveAuth = getAuthState();
  if (!liveAuth.loggedIn) {
    try {
      localStorage.removeItem(SANDBOX_AUTH_STORAGE_KEY);
    } catch {
      // Ignore storage errors and treat sandbox as logged out.
    }
    return LOGGED_OUT_STATE;
  }

  try {
    const raw = localStorage.getItem(SANDBOX_AUTH_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SandboxAuthState>;
      const loggedIn = Boolean(parsed?.loggedIn);
      const username = typeof parsed?.username === "string" ? parsed.username.trim() : "";
      const authorization =
        typeof parsed?.authorization === "string" ? parsed.authorization.trim() : "";
      if (loggedIn && username && authorization) {
        return { loggedIn: true, username, authorization };
      }
      localStorage.removeItem(SANDBOX_AUTH_STORAGE_KEY);
    }
  } catch {
    localStorage.removeItem(SANDBOX_AUTH_STORAGE_KEY);
  }

  if (liveAuth.loggedIn && shouldUseLiveAuthForSandbox()) {
    return {
      loggedIn: true,
      username: liveAuth.username,
      authorization: "",
    };
  }

  return LOGGED_OUT_STATE;
}

export function setSandboxAuthState(state: SandboxAuthState): void {
  const username = state.username.trim();
  const authorization = state.authorization.trim();
  if (!state.loggedIn || !username || !authorization) {
    clearSandboxAuthState();
    return;
  }
  localStorage.setItem(
    SANDBOX_AUTH_STORAGE_KEY,
    JSON.stringify({ loggedIn: true, username, authorization })
  );
  dispatchSandboxAuthChanged();
}

export function clearSandboxAuthState(): void {
  localStorage.removeItem(SANDBOX_AUTH_STORAGE_KEY);
  dispatchSandboxAuthChanged();
}

function buildAuthorization(username: string, password: string): string {
  return `Basic ${window.btoa(`${username}:${password}`)}`;
}

export function setSandboxAuthFromAdminCredentials(username: string, password: string): void {
  const nextUsername = username.trim();
  if (!nextUsername || !password) {
    clearSandboxAuthState();
    return;
  }
  setSandboxAuthState({
    loggedIn: true,
    username: nextUsername,
    authorization: buildAuthorization(nextUsername, password),
  });
}

export async function loginSandboxAdmin(username: string, password: string): Promise<SandboxLoginResult> {
  const nextUsername = username.trim();
  if (!nextUsername || !password) {
    return { ok: false, error: "Username and password are required." };
  }

  const authorization = buildAuthorization(nextUsername, password);
  try {
    const res = await fetch(`${SANDBOX_SERVICE_BASE_URL}/status`, {
      headers: { Authorization: authorization },
    });
    const payload = await res.json().catch((): null => null);
    if (!res.ok || payload?.status !== "ok") {
      return { ok: false, error: "Invalid admin credentials for sandbox access." };
    }
    return { ok: true, username: nextUsername, authorization };
  } catch {
    return { ok: false, error: "Unable to connect to the sandbox service." };
  }
}
