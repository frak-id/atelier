/**
 * Config-declared service accounts (`serviceAccounts` in sandbox.config.json),
 * reconciled at startup and every few minutes: the file says what exists, the
 * database follows. Secrets never sit in the file: the App private key, the
 * static token and the API key are read from env vars (or a key file). The
 * process env and the config file are read once at start: a changed env var or
 * an edited list applies on restart. A pass does pick up an org created since
 * and a changed `privateKeyFile`.
 *
 * Declared accounts are `managedBy: "config"`: the console can't edit or
 * delete them (admins can still add and revoke console-managed keys). An
 * account that stops being declared becomes console-managed again and its
 * config key is revoked, so removing it from the file never leaves a live
 * credential behind.
 */
import { readFileSync } from "node:fs";
import { API_KEY_PATTERN } from "../config/config.loader.ts";
import type { ServiceAccountConfig } from "../config/config.schema.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { ApiKeyService } from "./modules/api-key/index.ts";
import type { OrgMemberService } from "./modules/org-member/index.ts";
import type { OrganizationService } from "./modules/organization/index.ts";
import {
  normalizeGitHub,
  type ServiceAccountGitHubInput,
  type ServiceAccountRepository,
  type ServiceAccountService,
} from "./modules/service-account/index.ts";
import type { ServiceAccountGitHub } from "./types.ts";

const log = createChildLogger("service-account-config");

const CONFIG_KEY_NAME = "sandbox.config.json";

export interface ServiceAccountReconcileDeps {
  declared: () => ServiceAccountConfig[];
  accounts: ServiceAccountService;
  repository: Pick<ServiceAccountRepository, "getGitHub">;
  organizations: Pick<OrganizationService, "getBySlug">;
  orgMembers: Pick<OrgMemberService, "getMembership" | "addMember">;
  apiKeys: ApiKeyService;
  /** Tests inject these; the defaults read the process env and the disk. */
  readEnv?: (name: string) => string | undefined;
  readFile?: (path: string) => string;
}

/** A canonical JSON form (sorted keys), to compare two credentials. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

export function createServiceAccountReconciler(
  deps: ServiceAccountReconcileDeps,
) {
  const readEnv = deps.readEnv ?? ((name) => process.env[name]);
  const readFile = deps.readFile ?? ((path) => readFileSync(path, "utf-8"));
  const { accounts, apiKeys } = deps;

  // A problem that persists is logged once per change of state, not every
  // tick: the last message per account and topic.
  const lastWarning = new Map<string, string>();
  const warn = (key: string, message: string) => {
    if (lastWarning.get(key) === message) return;
    lastWarning.set(key, message);
    log.warn(message);
  };
  const clear = (key: string) => lastWarning.delete(key);

  /** The declared GitHub credential with its secret read now, or `undefined`
   * (with a warning) when the secret isn't available. */
  function readGitHub(
    sa: ServiceAccountConfig,
  ): ServiceAccountGitHubInput | undefined {
    const github = sa.github;
    if (!github) return undefined;
    const topic = `${sa.name}:github`;
    if ("tokenEnv" in github) {
      const token = readEnv(github.tokenEnv)?.trim();
      if (!token) {
        warn(topic, `${sa.name}: env var ${github.tokenEnv} is not set`);
        return undefined;
      }
      clear(topic);
      return {
        kind: "token",
        token,
        gitName: github.gitName,
        gitEmail: github.gitEmail,
      };
    }
    let privateKey: string | undefined;
    if (github.privateKeyEnv) {
      // Env vars often carry a PEM with literal "\n" instead of newlines.
      privateKey = readEnv(github.privateKeyEnv)?.replace(/\\n/g, "\n");
    } else if (github.privateKeyFile) {
      try {
        privateKey = readFile(github.privateKeyFile);
      } catch {
        warn(topic, `${sa.name}: can't read ${github.privateKeyFile}`);
        return undefined;
      }
    }
    if (!privateKey?.trim()) {
      warn(topic, `${sa.name}: the GitHub App private key is not available`);
      return undefined;
    }
    clear(topic);
    return {
      kind: "app",
      appId: github.appId,
      installationId: github.installationId,
      privateKey,
      ...(github.repositories ? { repositories: github.repositories } : {}),
      ...(github.permissions ? { permissions: github.permissions } : {}),
    };
  }

  function reconcileGitHub(id: string, sa: ServiceAccountConfig): void {
    if (!sa.github) {
      // Declared without a credential: none is kept.
      if (deps.repository.getGitHub(id)) {
        accounts.update(id, { github: null }, { fromConfig: true });
        log.info({ name: sa.name }, "GitHub credential removed (not declared)");
      }
      return;
    }
    const input = readGitHub(sa);
    if (!input) return; // keep what is stored until the secret is back
    const desired: ServiceAccountGitHub = normalizeGitHub(input);
    const stored = deps.repository.getGitHub(id);
    if (stored && canonical(stored) === canonical(desired)) return;
    accounts.update(id, { github: input }, { fromConfig: true });
    log.info({ name: sa.name }, "GitHub credential updated from config");
  }

  /** Exactly one config key per account, matching the declared env value. */
  function reconcileApiKey(id: string, sa: ServiceAccountConfig): void {
    const configKeys = () =>
      apiKeys.listByUser(id).filter((k) => k.managedBy === "config");
    if (!sa.apiKey) {
      for (const key of configKeys()) apiKeys.delete(key.id, id);
      return;
    }
    const topic = `${sa.name}:apiKey`;
    const raw = readEnv(sa.apiKey.env)?.trim();
    if (!raw) {
      warn(topic, `${sa.name}: env var ${sa.apiKey.env} is not set`);
      return;
    }
    if (!API_KEY_PATTERN.test(raw)) {
      warn(
        topic,
        `${sa.name}: env var ${sa.apiKey.env} is not a valid API key (atl_ + 32 or more characters)`,
      );
      return;
    }
    clear(topic);
    const scope = sa.apiKey.scope ?? "mcp";
    const found = apiKeys.findByRawKey(raw);
    const ownerTopic = `${sa.name}:apiKeyOwner`;
    if (found && found.userId !== id) {
      warn(
        ownerTopic,
        `${sa.name}: the key in ${sa.apiKey.env} is already registered to another user: skipped`,
      );
      return;
    }
    clear(ownerTopic);
    let keepId: string | undefined;
    if (found && found.managedBy === "config" && found.scope === scope) {
      keepId = found.id;
    } else {
      // Same raw value but another scope or origin: replace it (the hash is
      // unique, so the old row goes first).
      if (found) apiKeys.delete(found.id, id);
      keepId = apiKeys.createFromRawKey(id, CONFIG_KEY_NAME, raw, scope).id;
      log.info({ name: sa.name }, "Config API key registered");
    }
    for (const key of configKeys()) {
      if (key.id !== keepId) {
        apiKeys.delete(key.id, id);
        log.info({ name: sa.name }, "Superseded config API key revoked");
      }
    }
  }

  function reconcileOne(sa: ServiceAccountConfig): void {
    const org = deps.organizations.getBySlug(sa.org);
    const orgTopic = `${sa.name}:org`;
    if (!org) {
      // A fresh install creates the default org on the first login.
      warn(orgTopic, `${sa.name}: organization '${sa.org}' doesn't exist yet`);
      return;
    }
    clear(orgTopic);
    const role = sa.role ?? "member";
    const description = (sa.description ?? "").trim();

    let current = accounts.getByName(sa.name);
    if (!current) {
      current = accounts.create({
        name: sa.name,
        description,
        orgId: org.id,
        role,
        managedBy: "config",
      });
      log.info({ name: sa.name }, "Service account created from config");
    } else if (current.managedBy !== "config") {
      accounts.setManagedBy(current.id, "config");
      log.info({ name: sa.name }, "Console service account adopted by config");
    }

    const member = deps.orgMembers.getMembership(current.orgId, current.id);
    if (
      current.description !== description ||
      current.orgId !== org.id ||
      member?.role !== role
    ) {
      if (!member && current.orgId === org.id) {
        deps.orgMembers.addMember(org.id, current.id, role);
      }
      accounts.update(
        current.id,
        { description, orgId: org.id, role },
        { fromConfig: true },
      );
    }
    reconcileGitHub(current.id, sa);
    reconcileApiKey(current.id, sa);
  }

  /** An account no longer declared goes back to the console, without its
   * config key. */
  function releaseUndeclared(declaredNames: Set<string>): void {
    for (const sa of accounts.list()) {
      if (sa.managedBy !== "config" || declaredNames.has(sa.name)) continue;
      accounts.setManagedBy(sa.id, "console");
      for (const key of apiKeys.listByUser(sa.id)) {
        if (key.managedBy === "config") apiKeys.delete(key.id, sa.id);
      }
      log.warn(
        { name: sa.name },
        "Service account is no longer declared in config: now managed in the console, config key revoked",
      );
    }
  }

  return {
    reconcile(): void {
      const declared = deps.declared();
      try {
        releaseUndeclared(new Set(declared.map((sa) => sa.name)));
      } catch (err) {
        log.error({ err: errorMessage(err) }, "releasing undeclared accounts");
      }
      for (const sa of declared) {
        const topic = `${sa.name}:reconcile`;
        try {
          reconcileOne(sa);
          clear(topic);
        } catch (err) {
          // Messages of the service's own errors never carry a secret. A
          // failure that persists (a personal org, a refused move) is
          // logged once per change, not every tick.
          warn(
            topic,
            `${sa.name}: service account reconcile failed: ${errorMessage(err)}`,
          );
        }
      }
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type ServiceAccountReconciler = ReturnType<
  typeof createServiceAccountReconciler
>;
