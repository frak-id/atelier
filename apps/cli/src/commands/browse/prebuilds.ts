/** The cockpit's Prebuilds panel + the shared prebuild descriptors it and the
 * spawn flow render. */
import type { PrebuildRecord, PrebuildSpec } from "@atelier/spec";
import pc from "picocolors";
import { type AtelierApi, unwrap } from "../../client.ts";
import { detectGitRepo, type GitRepo, shortRepo } from "../../git.ts";
import { age } from "../../output.ts";
import * as ui from "../../ui.ts";
import { readJsonc } from "../../util.ts";
import {
  createPrebuildInteractive,
  findRepoBranchPrebuild,
  prebuildRepoBranch,
} from "../prebuild-create.ts";
import { runPrebuild } from "../sandbox.ts";
import { BACK } from "./common.ts";

/** A one-line summary for a prebuild: repo@branch · build age · base image. */
export function prebuildHint(p: PrebuildRecord): string {
  const { url: repo, branch } = prebuildRepoBranch(p);
  const parts: string[] = [];
  if (repo) parts.push(shortRepo(repo) + (branch ? `@${branch}` : ""));
  parts.push(`built ${age(p.createdAt)} ago`);
  if (p.image) parts.push(p.image);
  return parts.join(" · ");
}

export interface GitNudge {
  repo: GitRepo;
  /** `owner/name@branch` label for the menu hint. */
  label: string;
}

/** When the cwd is a git checkout with no prebuild yet for its repo+branch,
 * surface a nudge on the Prebuilds entry. Best-effort: any failure (no git, no
 * server) just returns null. */
export async function computeGitNudge(
  api: AtelierApi,
): Promise<GitNudge | null> {
  const repo = detectGitRepo();
  if (!repo) return null;
  try {
    const rows = unwrap(await api.v1.prebuilds.get());
    if (findRepoBranchPrebuild(rows, repo.url, repo.branch)) return null;
  } catch {
    return null;
  }
  const label = `${shortRepo(repo.url)}${repo.branch ? `@${repo.branch}` : ""}`;
  return { repo, label };
}

/** Prebuild panel: list snapshots, then rebuild one (re-bake its spec), bake a
 * new one from a spec file, or remove one. Inside a git checkout with no
 * matching prebuild, offer a one-shot "bake this repo" flow up top. */
export async function prebuildsMenu(api: AtelierApi): Promise<void> {
  const gitRepo = detectGitRepo();
  while (true) {
    const s = ui.spinner();
    s.start("Loading prebuilds…");
    let rows: PrebuildRecord[];
    try {
      rows = unwrap(await api.v1.prebuilds.get());
      s.stop(`${rows.length} prebuild(s)`);
    } catch (err) {
      s.stop("Failed to load prebuilds");
      ui.note(err instanceof Error ? err.message : String(err));
      return;
    }
    ui.note(
      rows.length > 0
        ? rows
            .map(
              (p) =>
                `${p.ref}  ${p.inUse ? pc.green("in-use") : pc.dim("unused")}  ${pc.dim(prebuildHint(p))}`,
            )
            .join("\n")
        : pc.dim("none baked yet"),
      "prebuilds",
    );
    const rebuildable = rows.filter((p) => p.spec);
    const gitMatch =
      gitRepo && findRepoBranchPrebuild(rows, gitRepo.url, gitRepo.branch);
    const canBakeGit = Boolean(gitRepo && !gitMatch);
    const action = await ui.select<
      "git" | "rebuild" | "new" | "rm" | "refresh" | "back"
    >({
      message: "Prebuilds",
      options: [
        ...(canBakeGit && gitRepo
          ? [
              {
                value: "git" as const,
                label: pc.green("✦ Bake prebuild for this repo"),
                hint: `${shortRepo(gitRepo.url)}${gitRepo.branch ? `@${gitRepo.branch}` : ""}`,
              },
            ]
          : []),
        ...(rebuildable.length > 0
          ? [
              {
                value: "rebuild" as const,
                label: "Rebuild a prebuild",
                hint: "re-bake its spec, bypassing the cache",
              },
            ]
          : []),
        {
          value: "new",
          label: "Bake a new prebuild",
          hint: "from a local spec file",
        },
        ...(rows.length > 0
          ? [{ value: "rm" as const, label: pc.red("Remove a prebuild") }]
          : []),
        { value: "refresh", label: pc.dim("Refresh") },
        { value: "back", label: pc.dim("Back") },
      ],
    });
    if (action === "back") return;
    if (action === "refresh") continue;
    if (action === "git") {
      if (gitRepo) {
        await createPrebuildInteractive(api, {
          repo: gitRepo.url,
          branch: gitRepo.branch,
          gitRepo,
        });
      }
    } else if (action === "rebuild") {
      const ref = await ui.select<string | typeof BACK>({
        message: "Rebuild which prebuild?",
        options: [
          ...rebuildable.map((p) => ({
            value: p.ref,
            label: p.ref,
            hint: prebuildHint(p),
          })),
          { value: BACK, label: pc.dim("Back") },
        ],
      });
      if (ref === BACK) continue;
      const p = rebuildable.find((x) => x.ref === ref);
      if (!p?.spec) continue;
      const sp = ui.spinner();
      sp.start(`Rebuilding ${ref}…`);
      try {
        const out = await runPrebuild(api, p.spec, true);
        sp.stop(`Rebuilt ${out.ref}`);
      } catch (err) {
        sp.stop("Rebuild failed", 1);
        ui.note(err instanceof Error ? err.message : String(err));
      }
    } else if (action === "new") {
      const file = await ui.text({
        message: "Prebuild spec file",
        placeholder: "./prebuild.json",
      });
      if (!file.trim()) continue;
      let spec: PrebuildSpec;
      try {
        spec = readJsonc<PrebuildSpec>(file.trim());
      } catch (err) {
        ui.note(`Can't read spec: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const sp = ui.spinner();
      sp.start("Baking prebuild…");
      try {
        const out = await runPrebuild(api, spec, false);
        sp.stop(`Baked ${out.ref}`);
      } catch (err) {
        sp.stop("Bake failed", 1);
        ui.note(err instanceof Error ? err.message : String(err));
      }
    } else if (action === "rm") {
      const ref = await ui.select<string | typeof BACK>({
        message: "Remove which prebuild?",
        options: [
          ...rows.map((p) => ({
            value: p.ref,
            label: p.ref,
            hint: prebuildHint(p),
          })),
          { value: BACK, label: pc.dim("Back") },
        ],
      });
      if (ref === BACK) continue;
      const yes = await ui.confirm({
        message: `Remove ${ref}?`,
        initialValue: false,
      });
      if (!yes) continue;
      await api.v1
        .prebuilds({ ref: ref as string })
        .delete()
        .then(unwrap);
      ui.note(`Removed ${ref}`);
    }
  }
}
