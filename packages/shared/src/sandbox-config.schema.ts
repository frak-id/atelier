/**
 * Schema for per-sandbox configuration injected into VMs.
 *
 * This is the contract between the provisioner (host) and the agent (VM).
 * The provisioner writes this to /etc/sandbox/config.json inside the VM rootfs,
 * and the agent + sandbox-init.sh read it at boot.
 */
import { type Static, Type } from "@sinclair/typebox";

export const SandboxServiceEntrySchema = Type.Object({
  port: Type.Optional(Type.Number()),
  command: Type.Optional(Type.String()),
  user: Type.Optional(Type.Union([Type.Literal("dev"), Type.Literal("root")])),
  autoStart: Type.Optional(Type.Boolean({ default: false })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  enabled: Type.Optional(Type.Boolean({ default: true })),
});

export type SandboxServiceEntry = Static<typeof SandboxServiceEntrySchema>;

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
    dashboardDomain: Type.String(),
    managerInternalUrl: Type.String(),
  }),
  services: Type.Record(Type.String(), SandboxServiceEntrySchema),
});

export type SandboxConfig = Static<typeof SandboxConfigSchema>;
