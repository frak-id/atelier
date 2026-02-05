import { loadConfig } from "@frak/atelier-shared";

export {
  CODE_SERVER,
  FIRECRACKER,
  LVM,
  OPENCODE,
  PATHS,
  SHARED_BINARIES,
  SSH_PROXY,
} from "@frak/atelier-shared/constants";

/** Loaded config - network, domains, sshProxy values come from sandbox.config.json / env vars */
export const atelierConfig = loadConfig();
