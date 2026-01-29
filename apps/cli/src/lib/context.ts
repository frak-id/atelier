import { loadConfig } from "@frak-sandbox/shared";

export {
  CODE_SERVER,
  FIRECRACKER,
  LVM,
  OPENCODE,
  PATHS,
  REGISTRY,
  SHARED_BINARIES,
  SSH_PROXY,
  TTYD,
} from "@frak-sandbox/shared/constants";

/** Loaded config - network, domains, sshProxy values come from sandbox.config.json / env vars */
export const frakConfig = loadConfig();
