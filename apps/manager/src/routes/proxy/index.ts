import { Elysia, t } from "elysia";
import { sandboxStore } from "../../state/store.ts";

const BASE_DOMAIN = "nivelais.com";
const STATIC_SUBDOMAINS = ["sandbox-api", "sandbox-dash"];

function extractSandboxId(
  host: string,
): { type: "vscode" | "opencode"; id: string } | null {
  const patterns = [
    {
      regex: new RegExp(
        `^sandbox-([^.]+)\\.${BASE_DOMAIN.replace(/\./g, "\\.")}$`,
      ),
      type: "vscode" as const,
    },
    {
      regex: new RegExp(
        `^opencode-([^.]+)\\.${BASE_DOMAIN.replace(/\./g, "\\.")}$`,
      ),
      type: "opencode" as const,
    },
  ];

  for (const { regex, type } of patterns) {
    const match = host.match(regex);
    if (match && match[1]) {
      return { type, id: match[1] };
    }
  }
  return null;
}

export const proxyRoutes = new Elysia({ prefix: "/internal" }).get(
  "/verify-domain",
  ({ query }) => {
    const domain = query.domain;
    if (!domain) {
      return new Response("Missing domain parameter", { status: 400 });
    }

    const subdomainMatch = domain.match(
      new RegExp(`^([^.]+)\\.${BASE_DOMAIN.replace(/\./g, "\\.")}$`),
    );
    if (subdomainMatch?.[1] && STATIC_SUBDOMAINS.includes(subdomainMatch[1])) {
      return new Response("OK", { status: 200 });
    }

    const info = extractSandboxId(domain);
    if (!info) {
      return new Response("Invalid domain format", { status: 400 });
    }

    const sandbox = sandboxStore.getById(info.id);
    if (!sandbox || sandbox.status !== "running") {
      return new Response("Sandbox not found or not running", { status: 404 });
    }

    return new Response("OK", { status: 200 });
  },
  {
    query: t.Object({
      domain: t.Optional(t.String()),
    }),
  },
);
