/**
 * Dashboard runtime configuration.
 * Values come from Vite env vars at build time, with sensible defaults for local dev.
 */

export const API_URL = import.meta.env.VITE_API_URL || "";

export const SSH_HOSTNAME =
  import.meta.env.VITE_SSH_HOSTNAME || "ssh.localhost";
export const SSH_PORT = Number(import.meta.env.VITE_SSH_PORT) || 2222;

export const AUTH_ORG_NAME = import.meta.env.VITE_AUTH_ORG_NAME || "";
