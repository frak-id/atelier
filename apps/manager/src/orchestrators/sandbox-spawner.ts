import { customAlphabet } from "nanoid";
import { eventBus } from "../infrastructure/events/index.ts";
import { networkService } from "../infrastructure/network/index.ts";
import { SshPiperService } from "../infrastructure/proxy/index.ts";
import type {
  CreateSandboxBody,
  CreateSandboxResponse,
  Sandbox,
  Workspace,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { SandboxPorts } from "./ports/sandbox-ports.ts";
import {
  createSystemSandbox,
  createWorkspaceSandbox,
} from "./workflows/index.ts";

const log = createChildLogger("sandbox-spawner");

export class SandboxSpawner {
  constructor(private readonly ports: SandboxPorts) {}

  async spawn(options: CreateSandboxBody = {}): Promise<CreateSandboxResponse> {
    const sandboxId = safeNanoid();

    if (!options.system && !options.workspaceId) {
      throw new Error("workspaceId is required for workspace sandbox");
    }

    const workspace =
      options.workspaceId && !options.system
        ? this.ports.workspaces.getById(options.workspaceId)
        : undefined;

    if (isMock()) {
      return this.spawnMock(sandboxId, workspace, options);
    }

    if (options.system) {
      return createSystemSandbox(sandboxId, options, this.ports);
    }

    if (!workspace) {
      throw new Error("Workspace not found for workspace sandbox");
    }

    return createWorkspaceSandbox(sandboxId, workspace, options, this.ports);
  }

  private async spawnMock(
    sandboxId: string,
    workspace: Workspace | undefined,
    options: CreateSandboxBody,
  ): Promise<Sandbox> {
    const network = await networkService.allocate(sandboxId);
    const generatePassword = customAlphabet(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    );

    const sandbox: Sandbox = {
      id: sandboxId,
      status: "running",
      workspaceId: options.workspaceId,
      runtime: {
        ipAddress: network.ipAddress,
        macAddress: network.macAddress,
        urls: {
          vscode: `https://sandbox-${sandboxId}.${config.domain.baseDomain}`,
          opencode: `https://opencode-${sandboxId}.${config.domain.baseDomain}`,
          ssh: await SshPiperService.registerRoute(
            sandboxId,
            network.ipAddress,
            this.ports.sshKeys.getValidPublicKeys(),
          ),
        },
        vcpus: options.vcpus ?? workspace?.config.vcpus ?? 2,
        memoryMb: options.memoryMb ?? workspace?.config.memoryMb ?? 2048,
        opencodePassword: generatePassword(32),
        pid: Math.floor(Math.random() * 100000),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.ports.sandbox.create(sandbox);
    eventBus.emit({
      type: "sandbox.created",
      properties: {
        id: sandboxId,
        workspaceId: options.workspaceId,
      },
    });

    log.info({ sandboxId }, "Mock sandbox created");
    return sandbox;
  }
}
