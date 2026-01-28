import { sandboxConfig, VM_PATHS } from "../constants.ts";
import { discoverConfigFiles } from "../utils/config.ts";

export function handleConfig(): Response {
  return Response.json(sandboxConfig ?? { error: "Config not found" });
}

export async function handleEditorConfig(): Promise<Response> {
  const [vscodeSettings, vscodeExtensions, opencodeAuth, opencodeConfig] =
    await Promise.all([
      Deno.readTextFile(VM_PATHS.vscodeSettings).catch(() => "{}"),
      Deno.readTextFile(VM_PATHS.vscodeExtensions).catch(() => "[]"),
      Deno.readTextFile(VM_PATHS.opencodeAuth).catch(() => "{}"),
      Deno.readTextFile(VM_PATHS.opencodeConfig).catch(() => "{}"),
    ]);

  return Response.json({
    vscode: {
      settings: JSON.parse(vscodeSettings),
      extensions: JSON.parse(vscodeExtensions),
    },
    opencode: {
      auth: JSON.parse(opencodeAuth),
      config: JSON.parse(opencodeConfig),
    },
  });
}

export function handleConfigDiscover(): Response {
  return Response.json({ configs: discoverConfigFiles() });
}

export async function handleConfigRead(url: URL): Promise<Response> {
  const path = url.searchParams.get("path");
  if (!path) {
    return Response.json(
      { error: "path query parameter required" },
      { status: 400 },
    );
  }

  const normalizedPath = path.replace(/^~/, "/home/dev");

  if (
    !normalizedPath.startsWith("/home/dev/") &&
    !normalizedPath.startsWith("/etc/sandbox/")
  ) {
    return Response.json(
      { error: "Access denied - path must be under /home/dev or /etc/sandbox" },
      { status: 403 },
    );
  }

  try {
    const content = await Deno.readTextFile(normalizedPath);
    const stats = await Deno.stat(normalizedPath);

    let contentType: "json" | "text" = "text";
    if (normalizedPath.endsWith(".json")) {
      try {
        JSON.parse(content);
        contentType = "json";
      } catch {
        //
      }
    }

    return Response.json({
      path: normalizedPath,
      displayPath: normalizedPath.replace("/home/dev", "~"),
      content,
      contentType,
      size: stats.size,
    });
  } catch {
    return Response.json(
      { error: "File not found or not readable" },
      { status: 404 },
    );
  }
}
