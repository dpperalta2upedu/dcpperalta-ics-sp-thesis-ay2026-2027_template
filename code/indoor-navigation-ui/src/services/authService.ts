import { SERVICE_BASE_URL } from "../utils/auth";

type ApiResult = {
  ok: boolean;
  error?: string;
  username?: string;
};

function extractError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const detail = record.detail;
    const error = record.error;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

export async function loginAdmin(username: string, password: string): Promise<ApiResult> {
  try {
    const res = await fetch(`${SERVICE_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim(), password }),
    });
    const payload = await res.json().catch((): null => null);
    if (!res.ok || !payload?.ok) {
      return { ok: false, error: extractError(payload, "Invalid username or password") };
    }
    return {
      ok: true,
      username: typeof payload.username === "string" ? payload.username.trim() : username.trim(),
    };
  } catch {
    return { ok: false, error: "Unable to connect to service." };
  }
}

export async function logoutAdmin(): Promise<void> {
  await fetch(`${SERVICE_BASE_URL}/auth/logout`, { method: "POST" });
}

export async function changeAdminPassword(
  username: string,
  currentPassword: string,
  newPassword: string,
  confirmNewPassword: string
): Promise<ApiResult> {
  try {
    const res = await fetch(`${SERVICE_BASE_URL}/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username.trim(),
        currentPassword,
        newPassword,
        confirmNewPassword,
        current_password: currentPassword,
        new_password: newPassword,
        confirm_new_password: confirmNewPassword,
      }),
    });
    const payload = await res.json().catch((): null => null);
    if (!res.ok || !payload?.ok) {
      return { ok: false, error: extractError(payload, "Invalid username or current password") };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Unable to connect to service." };
  }
}
