/**
 * Schema for per-sandbox configuration injected into VMs.
 *
 * This is the contract between the provisioner (host) and the agent (VM).
 * The provisioner writes this to /etc/sandbox/config.json inside the VM rootfs,
 * and the agent + sandbox-init.sh read it at boot.
 */
import { type Static, Type } from "@sinclair/typebox";
import { ServicesConfigSchema } from "./config.schema";

const RepoConfigSchema = Type.Object({
  clonePath: Type.String(),
  branch: Type.String(),
});

export const SandboxConfigSchema = Type.Object({
  sandboxId: Type.String(),
  workspaceId: Type.Optional(Type.String()),
  workspaceName: Type.Optional(Type.String()),
  repos: Type.Array(RepoConfigSchema, { default: [] }),
  createdAt: Type.String(),
  network: Type.Object({
    nfsHost: Type.String(),
    dashboardDomain: Type.String(),
    managerInternalUrl: Type.String(),
  }),
  services: ServicesConfigSchema,
});

export type SandboxConfig = Static<typeof SandboxConfigSchema>;
