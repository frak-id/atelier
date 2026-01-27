/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_SSH_HOSTNAME: string;
  readonly VITE_SSH_PORT: string;
  readonly VITE_AUTH_ORG_NAME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
