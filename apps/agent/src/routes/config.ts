import { sandboxConfig, VM_PATHS } from "../constants.ts";

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
