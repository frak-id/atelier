/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the API origin for non-same-origin hosts (e.g. Tauri). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
