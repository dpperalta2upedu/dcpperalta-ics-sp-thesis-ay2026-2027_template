const DISABLED_VALUE_PATTERN = /^(false|off|disabled|none)$/i;

function normalizeBaseUrl(rawValue: string | undefined, fallback: string): string {
  const value = rawValue?.trim();
  if (!value) {
    return fallback;
  }
  if (value === "/") {
    return "";
  }
  return value.replace(/\/+$/, "");
}

function normalizeOptionalUrl(rawValue: string | undefined, fallback: string): string {
  const value = rawValue?.trim();
  if (!value) {
    return fallback;
  }
  if (DISABLED_VALUE_PATTERN.test(value)) {
    return "";
  }
  if (value === "/") {
    return "";
  }
  return value.replace(/\/+$/, "");
}

export function buildServiceUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.replace(/^\/+/, "");
  if (!baseUrl) {
    return normalizedPath ? `/${normalizedPath}` : "/";
  }
  if (!normalizedPath) {
    return baseUrl;
  }
  return `${baseUrl}/${normalizedPath}`;
}

export const MAIN_SERVICE_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_SERVICE_BASE_URL, "/api");

export const SANDBOX_SERVICE_BASE_URL = normalizeBaseUrl(
  import.meta.env.VITE_SANDBOX_SERVICE_BASE_URL,
  buildServiceUrl(MAIN_SERVICE_BASE_URL, "sandbox")
);

export const UI_MAIN_LAYOUT_BACKUP_URL = normalizeOptionalUrl(
  import.meta.env.VITE_UI_MAIN_LAYOUT_BACKUP_URL,
  buildServiceUrl(MAIN_SERVICE_BASE_URL, "ui-main-layout/save")
);

export const SANDBOX_UI_MAIN_LAYOUT_BACKUP_URL = normalizeOptionalUrl(
  import.meta.env.VITE_SANDBOX_UI_MAIN_LAYOUT_BACKUP_URL,
  buildServiceUrl(SANDBOX_SERVICE_BASE_URL, "ui-main-layout/save")
);
