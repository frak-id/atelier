import { readFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import {
  type SandboxConfig,
  SandboxConfigSchema,
} from "./sandbox-config.schema";

const DEFAULT_PATH = "/etc/sandbox/config.json";

export function loadSandboxConfig(
  configFile = DEFAULT_PATH,
): SandboxConfig | null {
  try {
    const raw = JSON.parse(readFileSync(configFile, "utf-8"));
    const withDefaults = Value.Default(SandboxConfigSchema, raw);
    const converted = Value.Convert(SandboxConfigSchema, withDefaults);
    const cleaned = Value.Clean(SandboxConfigSchema, converted);
    return cleaned as SandboxConfig;
  } catch {
    return null;
  }
}
