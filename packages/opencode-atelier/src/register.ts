import type { Adaptor } from "./types.ts";

type InstallFn = (type: string, adaptor: Adaptor) => void;

const ADAPTOR_TYPE = "atelier";

export async function registerAdaptor(adaptor: Adaptor): Promise<boolean> {
  const install = await resolveInstallFn();
  if (install) {
    install(ADAPTOR_TYPE, adaptor);
    console.log("[atelier] Registered via installAdaptor");
    return true;
  }

  (globalThis as Record<string, unknown>)["__opencode_custom_adaptors__"] ??=
    {};
  const registry = (globalThis as Record<string, unknown>)[
    "__opencode_custom_adaptors__"
  ] as Record<string, Adaptor>;
  registry[ADAPTOR_TYPE] = adaptor;

  console.warn(
    "[atelier] installAdaptor not found — " +
      "registered on globalThis.__opencode_custom_adaptors__. " +
      "Patch opencode's getAdaptor() to check this.",
  );
  return false;
}

async function resolveInstallFn(): Promise<InstallFn | null> {
  const candidates = [
    process.env["OPENCODE_ADAPTORS_PATH"],
    "opencode/src/control-plane/adaptors/index.ts",
    "opencode/src/control-plane/adaptors",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.installAdaptor === "function") {
        return mod.installAdaptor as InstallFn;
      }
    } catch {}
  }

  return null;
}
