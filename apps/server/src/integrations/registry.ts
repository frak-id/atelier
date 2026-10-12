/**
 * The set of integrations switched on for this server, read ONCE at boot from
 * the environment: `ATELIER_INTEGRATION_<ID>` (`true`/`1` = on, anything else
 * or unset = off) and the integration's `serverSettings` as
 * `ATELIER_INTEGRATION_<ID>_<NAME>` (see `integration.ts` for the naming).
 *
 * Deliberately NOT in the server-config registry: that store is writable by
 * any signed-in user (`PUT /api/config/:key` has no admin gate), so a setting
 * kept there would let anyone repoint where people's credentials are sent.
 * The environment is the operator's alone.
 *
 * Misconfiguration throws at boot (a bad id, two integrations whose
 * environment names collide, a malformed or — in production — non-https URL
 * setting of an enabled integration) rather than failing on first use.
 */
import { isProduction } from "../shared/lib/config.ts";
import type { Integration, ServerSettingDef } from "./integration.ts";

const ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
const SETTING_NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,30}$/;
const ENV_PREFIX = "ATELIER_INTEGRATION_";

export interface IntegrationRegistry {
  /** The integrations the operator switched on, in catalog order. */
  enabled(): Integration[];
  /** An enabled integration, else undefined. */
  get(id: string): Integration | undefined;
  /** Whether the catalog has this id, enabled or not (cleanup of leftovers). */
  isKnown(id: string): boolean;
  /** An enabled integration's settings, defaults filled in. */
  serverSettings(id: string): Readonly<Record<string, string>>;
}

export function integrationEnvName(id: string): string {
  return `${ENV_PREFIX}${id.toUpperCase().replaceAll("-", "_")}`;
}

export function settingEnvName(id: string, name: string): string {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return `${integrationEnvName(id)}_${snake}`;
}

function resolveSetting(
  id: string,
  def: ServerSettingDef,
  env: Record<string, string | undefined>,
  production: boolean,
): string {
  const envName = settingEnvName(id, def.name);
  const value = env[envName] || def.default;
  if (def.type === "url") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${envName} must be an absolute URL (got "${value}")`);
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && !production)
    ) {
      throw new Error(
        `${envName} must be an ${production ? "https" : "http(s)"} URL ` +
          `(got "${value}")`,
      );
    }
  }
  return value;
}

export function createIntegrationRegistry(
  catalog: readonly Integration[],
  env: Record<string, string | undefined> = process.env,
  production: boolean = isProduction(),
): IntegrationRegistry {
  const envNames = new Map<string, string>();
  const claim = (envName: string, owner: string) => {
    const taken = envNames.get(envName);
    if (taken) {
      throw new Error(
        `Integration environment name ${envName} is used by both ` +
          `${taken} and ${owner}`,
      );
    }
    envNames.set(envName, owner);
  };

  for (const { manifest } of catalog) {
    if (!ID_PATTERN.test(manifest.id)) {
      throw new Error(`Invalid integration id "${manifest.id}"`);
    }
    claim(integrationEnvName(manifest.id), `integration "${manifest.id}"`);
    for (const def of manifest.serverSettings ?? []) {
      if (!SETTING_NAME_PATTERN.test(def.name)) {
        throw new Error(
          `Invalid setting name "${def.name}" in integration "${manifest.id}"`,
        );
      }
      claim(
        settingEnvName(manifest.id, def.name),
        `setting "${def.name}" of "${manifest.id}"`,
      );
    }
  }

  const active = new Map<
    string,
    { integration: Integration; settings: Record<string, string> }
  >();
  for (const integration of catalog) {
    const { id, serverSettings = [] } = integration.manifest;
    const flag = env[integrationEnvName(id)];
    if (flag !== "true" && flag !== "1") continue;
    const settings: Record<string, string> = {};
    for (const def of serverSettings) {
      settings[def.name] = resolveSetting(id, def, env, production);
    }
    active.set(id, { integration, settings });
  }

  return {
    enabled: () => [...active.values()].map((a) => a.integration),
    get: (id) => active.get(id)?.integration,
    isKnown: (id) => catalog.some((i) => i.manifest.id === id),
    serverSettings: (id) => Object.freeze({ ...active.get(id)?.settings }),
  };
}
