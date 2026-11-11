/**
 * Who sees (and cancels) a job of the `/v1/jobs` feed. The `jobs` table has
 * no identity column, so the rule reads the job's opaque metadata:
 * `metadata.owner` is the user who started it (set by every user-initiated
 * dispatch in api/; system jobs, like the scheduler's rebuilds, have none),
 * and the sandbox a job works on is `metadata.sandboxId` or, for the
 * lifecycle ops, its `target`.
 *
 * A caller sees a job when they are a server admin, started it, or may
 * access its sandbox (the sandbox access rule). Image builds, whose logs
 * `/v1/images/:name/logs` already shows everyone, are visible to all.
 * Cancel is narrower: the owner or a server admin, or, for an ownerless job,
 * anyone who may access its sandbox.
 */
import type { JobRecord } from "../runtime/index.ts";
import type { ServerContainer } from "./container.ts";

/** The job kinds whose `target` is a sandbox id. */
const SANDBOX_TARGET_KINDS = new Set<JobRecord["kind"]>([
  "sandbox-pause",
  "sandbox-resume",
  "sandbox-snapshot",
  "sandbox-destroy",
]);

/** Job metadata a caller's own input must never set (`owner`, and the
 * sandbox links that widen who sees the job). */
const SERVER_OWNED_METADATA = ["owner", "sandboxId", "forkOf"];

/** The job metadata for a user-initiated dispatch: the caller's own opaque
 * `metadata` (a recipe's labels) with the server-owned keys dropped, then
 * `owner` set to the caller. */
export function ownedJobMetadata(
  owner: string | undefined,
  metadata?: Record<string, string>,
): Record<string, string> | undefined {
  const rest = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => !SERVER_OWNED_METADATA.includes(key),
    ),
  );
  const merged = owner === undefined ? rest : { ...rest, owner };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The sandbox a job works on, when it names one. */
function jobSandboxId(job: JobRecord): string | undefined {
  return (
    job.metadata?.sandboxId ??
    (SANDBOX_TARGET_KINDS.has(job.kind) ? job.target : undefined)
  );
}

export interface JobAccess {
  canSee(userId: string, job: JobRecord): boolean;
  canCancel(userId: string, job: JobRecord): boolean;
}

export function createJobAccess({
  runtime,
  control,
}: Pick<ServerContainer, "runtime" | "control">): JobAccess {
  const mayAccessSandbox = (userId: string, job: JobRecord): boolean => {
    const sandboxId = jobSandboxId(job);
    const labels = sandboxId ? runtime.getLabels(sandboxId) : undefined;
    return labels !== undefined && control.canAccessSandbox(userId, labels);
  };
  // A service account is never treated as an admin here, even when it owns
  // the default org: it sees and cancels its own jobs only.
  const isAdmin = (userId: string): boolean =>
    control.userService.getById(userId)?.kind !== "service" &&
    control.defaultOrg.isServerAdmin(userId);
  return {
    canSee(userId, job) {
      return (
        job.kind === "image-build" ||
        job.metadata?.owner === userId ||
        isAdmin(userId) ||
        mayAccessSandbox(userId, job)
      );
    },
    canCancel(userId, job) {
      const owner = job.metadata?.owner;
      if (owner === userId || isAdmin(userId)) {
        return true;
      }
      return owner === undefined && mayAccessSandbox(userId, job);
    },
  };
}
