import { createPrivateKey } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { OrgMemberRole } from "../../db/schema.ts";
import type {
  ApiKey,
  ApiKeyScope,
  ManagedBy,
  ServiceAccount,
  ServiceAccountGitHub,
} from "../../types.ts";
import type { ApiKeyService } from "../api-key/index.ts";
import type { OrgMemberService } from "../org-member/index.ts";
import type { OrganizationService } from "../organization/index.ts";
import type { UserRepository } from "../user/index.ts";
import type {
  ServiceAccountRepository,
  StoredGitHub,
} from "./service-account.repository.ts";

const log = createChildLogger("service-account-service");

export const SERVICE_ACCOUNT_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const DIGITS = /^\d+$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;
const PERMISSION_NAME = /^[a-z_]+$/;

const CONFIG_MANAGED =
  "This service account is managed by sandbox.config.json: change it there";

/**
 * The GitHub credential as an admin (or the config) states it. A secret may
 * be left out only when the kind is unchanged: the stored one is kept.
 * `appId` and `installationId` are digit strings (numbers are accepted, a
 * config file naturally writes them so).
 */
export type ServiceAccountGitHubInput =
  | {
      kind: "app";
      appId: string | number;
      installationId: string | number;
      privateKey?: string;
      repositories?: string[];
      permissions?: Record<string, string>;
    }
  | { kind: "token"; token?: string; gitName: string; gitEmail: string };

export interface CreateServiceAccountInput {
  name: string;
  description?: string;
  orgId: string;
  role?: OrgMemberRole;
  github?: ServiceAccountGitHubInput;
  managedBy?: ManagedBy;
  createdBy?: string;
}

export interface UpdateServiceAccountInput {
  description?: string;
  orgId?: string;
  role?: OrgMemberRole;
  /** `null` removes the credential; absent leaves it. */
  github?: ServiceAccountGitHubInput | null;
}

/** A stored credential that can be reused as the `previous` secret. */
function readable(
  stored: StoredGitHub | undefined,
): ServiceAccountGitHub | undefined {
  return stored?.kind === "unreadable" ? undefined : stored;
}

/** An App private key is PKCS#1 or PKCS#8 PEM. Never echoes the key. */
function assertPrivateKey(pem: string): void {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw new Error("not an RSA key");
  } catch {
    throw new ValidationError(
      "github.privateKey must be an RSA private key in PEM format (PKCS#1 or PKCS#8)",
    );
  }
}

function requiredText(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text) throw new ValidationError(`${field} is required`);
  return text;
}

function digits(value: string | number | undefined, field: string): string {
  const text = String(value ?? "").trim();
  if (!DIGITS.test(text)) {
    throw new ValidationError(`${field} must be a numeric id`);
  }
  return text;
}

/**
 * Validate a credential and turn it into its stored shape. `previous` is the
 * stored credential: a missing secret falls back to it when the kind is the
 * same, otherwise it is an error.
 */
export function normalizeGitHub(
  input: ServiceAccountGitHubInput,
  previous?: ServiceAccountGitHub,
): ServiceAccountGitHub {
  if (input.kind === "token") {
    const kept = previous?.kind === "token" ? previous.token : undefined;
    return {
      kind: "token",
      token: requiredText(input.token ?? kept, "github.token"),
      gitName: requiredText(input.gitName, "github.gitName"),
      gitEmail: requiredText(input.gitEmail, "github.gitEmail"),
    };
  }

  const kept = previous?.kind === "app" ? previous.privateKey : undefined;
  const privateKey = input.privateKey?.trim() ? input.privateKey : kept;
  if (!privateKey) throw new ValidationError("github.privateKey is required");
  assertPrivateKey(privateKey);

  const repositories = input.repositories;
  if (repositories?.length === 0) {
    // Dropping it would silently widen the token to every repository.
    throw new ValidationError(
      "github.repositories must not be empty: omit it to allow every repository",
    );
  }
  if (repositories) {
    for (const repo of repositories) {
      if (!REPOSITORY_NAME.test(repo)) {
        throw new ValidationError(
          `github.repositories: '${repo}' is not a bare repository name`,
        );
      }
    }
  }
  let permissions: Record<string, "read" | "write"> | undefined;
  if (input.permissions) {
    permissions = {};
    for (const [name, level] of Object.entries(input.permissions)) {
      if (
        !PERMISSION_NAME.test(name) ||
        (level !== "read" && level !== "write")
      ) {
        throw new ValidationError(
          `github.permissions: '${name}' must map to 'read' or 'write'`,
        );
      }
      permissions[name] = level;
    }
  }
  return {
    kind: "app",
    appId: digits(input.appId, "github.appId"),
    installationId: digits(input.installationId, "github.installationId"),
    privateKey,
    ...(repositories ? { repositories } : {}),
    ...(permissions && Object.keys(permissions).length > 0
      ? { permissions }
      : {}),
  };
}

export interface ServiceAccountDeps {
  repository: ServiceAccountRepository;
  organizations: OrganizationService;
  orgMembers: OrgMemberService;
  apiKeys: ApiKeyService;
  users: UserRepository;
  /** Called after an account's credential is edited or removed, or the
   * account deleted: the cached token is dropped (and revoked unless
   * edited). */
  credentialDropped?: (id: string, change: "edited" | "removed") => void;
}

/**
 * Service accounts: non-human users an admin manages for agents. The service
 * writes their memberships through the unchecked org-member paths (the
 * ordinary invite/role/remove paths refuse a service account), and never
 * returns a secret: only `ServiceAccountRepository.getGitHub` does, to the
 * credential code.
 */
export class ServiceAccountService {
  constructor(private readonly deps: ServiceAccountDeps) {}

  list(): ServiceAccount[] {
    return this.deps.repository.list();
  }

  get(id: string): ServiceAccount {
    const sa = this.deps.repository.getById(id);
    if (!sa) throw new NotFoundError("ServiceAccount", id);
    return sa;
  }

  getByName(name: string): ServiceAccount | undefined {
    return this.deps.repository.getByName(name);
  }

  /** The account's role in its org. */
  roleOf(sa: ServiceAccount): OrgMemberRole | undefined {
    return this.deps.orgMembers.getMembership(sa.orgId, sa.id)?.role;
  }

  create(input: CreateServiceAccountInput): ServiceAccount {
    const { repository, users, orgMembers } = this.deps;
    const name = input.name;
    if (!SERVICE_ACCOUNT_NAME_PATTERN.test(name)) {
      throw new ValidationError(
        "name must be 1-39 lowercase letters, digits or hyphens, not starting or ending with a hyphen",
      );
    }
    this.assertTeamOrg(input.orgId);
    const username = `${name}[bot]`;
    if (repository.getByName(name) || users.getByUsername(username)) {
      throw new ConflictError(`Service account '${name}' already exists`);
    }
    const github = input.github ? normalizeGitHub(input.github) : undefined;
    const id = `sa_${safeNanoid()}`;
    const sa = repository.create({
      id,
      name,
      username,
      email: `${name}@service-accounts.invalid`,
      description: input.description?.trim() ?? "",
      orgId: input.orgId,
      managedBy: input.managedBy ?? "console",
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(github ? { github } : {}),
    });
    try {
      orgMembers.addMember(input.orgId, id, input.role ?? "member");
    } catch (err) {
      repository.delete(id);
      throw err;
    }
    log.info({ serviceAccountId: id, name }, "Service account created");
    return sa;
  }

  /**
   * Edit description, org/role and GitHub credential. A config-managed
   * account refuses unless the caller is the config reconcile.
   */
  update(
    id: string,
    patch: UpdateServiceAccountInput,
    opts: { fromConfig?: boolean } = {},
  ): ServiceAccount {
    const { repository, orgMembers } = this.deps;
    const sa = this.get(id);
    if (sa.managedBy === "config" && !opts.fromConfig) {
      throw new ValidationError(CONFIG_MANAGED);
    }

    // Validate everything before the first write.
    const github =
      patch.github === undefined
        ? undefined
        : patch.github === null
          ? null
          : normalizeGitHub(patch.github, readable(repository.getGitHub(id)));
    const orgId = patch.orgId ?? sa.orgId;
    if (orgId !== sa.orgId) this.assertTeamOrg(orgId);

    // One transaction: a refusal (the last owner of the old org) leaves the
    // row, the credential and both memberships as they were.
    const description = patch.description?.trim();
    repository.transaction(() => {
      if (orgId !== sa.orgId) {
        const role = patch.role ?? this.roleOf(sa) ?? "member";
        orgMembers.addMember(orgId, id, role);
        orgMembers.removeUnchecked(sa.orgId, id);
      } else if (patch.role && patch.role !== this.roleOf(sa)) {
        orgMembers.setRole(orgId, id, patch.role);
      }
      if (description !== undefined || orgId !== sa.orgId) {
        repository.update(id, {
          ...(description !== undefined ? { description } : {}),
          ...(orgId !== sa.orgId ? { orgId } : {}),
        });
      }
      if (github !== undefined) repository.setGitHub(id, github);
    });
    if (github !== undefined) {
      this.deps.credentialDropped?.(id, github === null ? "removed" : "edited");
    }
    log.info({ serviceAccountId: id }, "Service account updated");
    return this.get(id);
  }

  /** Hand a config-declared account back to the console (no longer declared)
   * or take a console one over (a declaration now names it). */
  setManagedBy(id: string, managedBy: ManagedBy): void {
    this.deps.repository.update(id, { managedBy });
  }

  delete(id: string): void {
    const sa = this.get(id);
    if (sa.managedBy === "config") throw new ValidationError(CONFIG_MANAGED);
    this.deps.orgMembers.removeUnchecked(sa.orgId, id);
    this.deps.repository.delete(id);
    this.deps.credentialDropped?.(id, "removed");
    log.info({ serviceAccountId: id }, "Service account deleted");
  }

  listKeys(id: string): ApiKey[] {
    this.get(id);
    return this.deps.apiKeys.listByUser(id);
  }

  createKey(
    id: string,
    input: { name: string; expiresAt?: string; scope?: ApiKeyScope },
  ): { apiKey: ApiKey; rawKey: string } {
    this.get(id);
    const name = requiredText(input.name, "name");
    let expiresAt: string | undefined;
    if (input.expiresAt !== undefined) {
      const at = Date.parse(input.expiresAt);
      if (Number.isNaN(at) || at <= Date.now()) {
        throw new ValidationError("expiresAt must be a future date");
      }
      // Stored as ISO: key validation compares it as a string.
      expiresAt = new Date(at).toISOString();
    }
    return this.deps.apiKeys.create(id, name, expiresAt, input.scope ?? "mcp");
  }

  revokeKey(id: string, keyId: string): void {
    const key = this.listKeys(id).find((k) => k.id === keyId);
    if (!key) throw new NotFoundError("ApiKey", keyId);
    if (key.managedBy === "config") {
      throw new ValidationError(
        "This key is declared in sandbox.config.json: remove it there",
      );
    }
    this.deps.apiKeys.delete(keyId, id);
  }

  private assertTeamOrg(orgId: string): void {
    const org = this.deps.organizations.getByIdOrThrow(orgId);
    if (org.personal) {
      throw new ValidationError(
        "A service account can't belong to a personal organization",
      );
    }
  }
}
