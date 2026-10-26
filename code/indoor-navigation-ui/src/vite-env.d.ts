/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVICE_BASE_URL?: string;
  readonly VITE_SANDBOX_SERVICE_BASE_URL?: string;
  readonly VITE_UI_MAIN_LAYOUT_BACKUP_URL?: string;
  readonly VITE_SANDBOX_UI_MAIN_LAYOUT_BACKUP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
