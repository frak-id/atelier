import * as p from "@clack/prompts";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  loadConfig,
  validateConfig,
} from "@frak-sandbox/shared";
import { fileExists } from "../lib/shell";

export async function configCommand(args: string[] = []) {
  const action = args[0];

  if (!action) {
    const selected = await p.select({
      message: "Config action:",
      options: [
        { value: "show", label: "Show", hint: "Print current config" },
        { value: "set", label: "Set", hint: "Set a config value" },
        {
          value: "validate",
          label: "Validate",
          hint: "Validate config values",
        },
      ],
    });

    if (p.isCancel(selected)) {
      p.cancel("Cancelled");
      return;
    }

    return runAction(selected as string, args.slice(1));
  }

  return runAction(action, args.slice(1));
}

async function runAction(action: string, args: string[]) {
  switch (action) {
    case "show":
      await showConfig();
      break;
    case "set":
      await setConfig(args);
      break;
    case "validate":
      await validateConfigCommand();
      break;
    default:
      p.log.error(`Unknown action: ${action}`);
      p.log.info("Available: show, set, validate");
  }
}

async function showConfig() {
  const configPath = getConfigPath();
  const exists = await fileExists(configPath);

  if (!exists) {
    p.log.warn(`Config not found at ${configPath}. Showing defaults.`);
    console.log(JSON.stringify(DEFAULT_CONFIG, null, 2));
    return;
  }

  const content = await Bun.file(configPath).text();
  console.log(
    content.trim().length ? content : JSON.stringify(DEFAULT_CONFIG, null, 2),
  );
}

async function setConfig(args: string[]) {
  const configPath = getConfigPath();
  const exists = await fileExists(configPath);

  let path = args[0];
  let value = args[1];

  if (!path) {
    const input = await p.text({
      message: "Config path (e.g., domains.api)",
      validate: (val) => (val ? undefined : "Path required"),
    });
    if (p.isCancel(input)) return;
    path = input;
  }

  if (value === undefined) {
    const input = await p.text({
      message: "Value",
    });
    if (p.isCancel(input)) return;
    value = input;
  }

  const config = exists
    ? parseConfigFile(await Bun.file(configPath).text(), configPath)
    : {
        ...structuredClone(DEFAULT_CONFIG),
        runtime: { ...DEFAULT_CONFIG.runtime, mode: "production" },
      };

  setNestedValue(config, path, parseValue(path, value));

  await Bun.write(configPath, JSON.stringify(config, null, 2));
  p.log.success(`Updated ${path}`);
  await validateConfigCommand();
}

async function validateConfigCommand() {
  const configPath = getConfigPath();
  const exists = await fileExists(configPath);

  if (!exists) {
    p.log.error(`Config not found at ${configPath}`);
    return;
  }

  const config = loadConfig({ configFile: configPath });
  const errors = validateConfig(config, {
    requireAuth: true,
    requireDomains: true,
  });

  if (errors.length === 0) {
    p.log.success("Config is valid");
    return;
  }

  p.log.error("Config validation errors:");
  for (const err of errors) {
    console.log(`- ${err.field}: ${err.message}`);
  }
}

function getConfigPath(): string {
  return process.env.FRAK_CONFIG || `/etc/frak-sandbox/${CONFIG_FILE_NAME}`;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
) {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string;
    if (!(key in current)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1] as string] = value;
}

function parseValue(path: string, raw: string): unknown {
  const trimmed = raw.trim();

  if (path.endsWith("dnsServers") || path.endsWith("allowedUsers")) {
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (!Number.isNaN(Number(trimmed)) && trimmed !== "") return Number(trimmed);

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function parseConfigFile(
  content: string,
  path: string,
): Record<string, unknown> {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
}
