import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  gitSourceService,
  sessionTemplateService,
  workspaceService,
} from "../../container.ts";
import type { RepoConfig, Workspace } from "../../schemas/index.ts";

function repoUrl(repo: RepoConfig): string {
  if ("url" in repo) return repo.url;
  const source = gitSourceService.getById(repo.sourceId);
  if (!source) return repo.repo;
  if (source.type === "github") return `github.com/${repo.repo}`;
  return repo.repo;
}

function formatWorkspace(ws: Workspace) {
  const repos = ws.config.repos.map((r) => ({
    url: repoUrl(r),
    branch: r.branch,
    clonePath: r.clonePath,
  }));

  const devCommands = (ws.config.devCommands ?? []).map((d) => ({
    name: d.name,
    command: d.command,
    port: d.port,
    workdir: d.workdir,
  }));

  const { templates } = sessionTemplateService.getMergedTemplates(ws.id);
  const sessionTemplatesSummary = templates.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
  }));

  return {
    id: ws.id,
    name: ws.name,
    description: ws.config.description ?? null,
    defaultBranch: repos[0]?.branch ?? null,
    repos,
    devCommands,
    sessionTemplates: sessionTemplatesSummary,
    baseImage: ws.config.baseImage,
    vcpus: ws.config.vcpus,
    memoryMb: ws.config.memoryMb,
  };
}

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool(
    "list_workspaces",
    {
      title: "List Workspaces",
      description:
        "List all configured workspaces with their repos, dev commands, " +
        "and session templates. Use this to understand which projects " +
        "are available and how they are configured.",
      inputSchema: z.object({}),
    },
    async () => {
      const workspaces = workspaceService.getAll();
      const result = workspaces.map(formatWorkspace);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
