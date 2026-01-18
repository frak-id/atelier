import { treaty } from "@elysiajs/eden";
import type { App as ManagerApp } from "@frak-sandbox/manager";

const API_HOST = import.meta.env.PROD
  ? "https://sandbox-api.nivelais.com"
  : "http://localhost:4000";

export const api = treaty<ManagerApp>(API_HOST);

export type {
  ConfigFile,
  ConfigFileContentType,
  Sandbox,
  Workspace,
} from "@frak-sandbox/manager/types";

// Infer GitHub repository type from API response
type GitHubReposResponse = Awaited<
  ReturnType<typeof api.api.github.repos.get>
>["data"];
export type GitHubRepository =
  NonNullable<GitHubReposResponse>["repositories"][number];
