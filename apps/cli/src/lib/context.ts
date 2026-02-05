import { loadConfig } from "@frak/atelier-shared";
import { getSharedBinaries } from "@frak/atelier-shared/constants";

export {
  CODE_SERVER,
  FIRECRACKER,
  LVM,
  OPENCODE,
  PATHS,
  SSH_PROXY,
} from "@frak/atelier-shared/constants";

/** Loaded config - network, domains, sshProxy values come from sandbox.config.json / env vars */
export const atelierConfig = loadConfig();

export const SHARED_BINARIES = getSharedBinaries({
  opencode: atelierConfig.versions.opencode,
  codeServer: atelierConfig.versions.codeServer,
});
