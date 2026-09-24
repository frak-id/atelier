import { describe, expect, test } from "bun:test";
import type { PrebuildRecord } from "@atelier/spec";
import {
  buildRepoCatalog,
  type CatalogJob,
  type CatalogRepo,
  catalogCounts,
  filterCatalog,
  jobRepoKeys,
} from "./repo-catalog.ts";

function repo(fullName: string, extra: Partial<CatalogRepo> = {}) {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    fullName,
    owner,
    name,
    cloneUrl: `https://github.com/${fullName}.git`,
    defaultBranch: "main",
    description: null,
    archived: false,
    fork: false,
    ...extra,
  } satisfies CatalogRepo;
}

function prebuild(
  ref: string,
  url: string,
  createdAt: string,
  branch?: string,
): PrebuildRecord {
  return {
    ref,
    hash: ref,
    image: "dev-base:latest",
    createdAt,
    spec: {
      source: { image: "dev-base" },
      repos: [{ url, ...(branch ? { branch } : {}), clonePath: "x" }],
    },
  };
}

function job(
  id: string,
  target: string,
  status: CatalogJob["status"],
  createdAt: string,
  extra: Partial<CatalogJob> = {},
): CatalogJob {
  return { id, kind: "prebuild", status, target, createdAt, ...extra };
}

describe("jobRepoKeys", () => {
  test("splits multi-repo targets and strips branches", () => {
    expect(
      jobRepoKeys("https://github.com/a/b.git#dev, git@github.com:a/c.git"),
    ).toEqual(["github.com/a/b", "github.com/a/c"]);
    expect(jobRepoKeys(undefined)).toEqual([]);
  });
});

describe("buildRepoCatalog", () => {
  const atelier = repo("frak-id/atelier");
  const wallet = repo("frak-id/wallet");
  const docs = repo("frak-id/docs");
  const infra = repo("frak-id/infra");

  test("derives per-repo state from prebuilds + jobs", () => {
    const prebuilds = [
      // scp URL from the CLI still matches the https repo
      prebuild("snap-a", "git@github.com:frak-id/atelier.git", "2026-09-02"),
      prebuild("snap-i", "https://github.com/frak-id/infra", "2026-09-01"),
    ];
    const jobs = [
      job(
        "j3",
        "https://github.com/frak-id/wallet.git",
        "running",
        "2026-09-03",
      ),
      job("j2", "https://github.com/frak-id/docs.git", "failed", "2026-09-02", {
        error: "exit 1",
      }),
      // a toolset job with a colliding-looking target is ignored
      {
        ...job(
          "j1",
          "https://github.com/frak-id/docs.git",
          "running",
          "2026-09-01",
        ),
        kind: "toolset-build",
      },
      // an OLD failure on infra, older than its newest bake: not surfaced
      job("j0", "https://github.com/frak-id/infra", "failed", "2026-08-01"),
    ];
    const out = buildRepoCatalog(
      [atelier, wallet, docs, infra],
      prebuilds,
      jobs,
    );
    expect(out.map((e) => [e.repo.name, e.state])).toEqual([
      ["atelier", "prebuilt"],
      ["wallet", "building"],
      ["docs", "failed"],
      ["infra", "prebuilt"],
    ]);
    expect(out[0]?.latest?.ref).toBe("snap-a");
    expect(out[1]?.activeJob?.id).toBe("j3");
    expect(out[2]?.failedJob?.error).toBe("exit 1");
    expect(out[3]?.failedJob).toBeUndefined();
  });

  test("a failed rebuild keeps the repo prebuilt but surfaces the failure", () => {
    const out = buildRepoCatalog(
      [atelier],
      [prebuild("snap-a", atelier.cloneUrl, "2026-09-01")],
      [job("j", atelier.cloneUrl, "failed", "2026-09-05")],
    );
    expect(out[0]?.state).toBe("prebuilt");
    expect(out[0]?.failedJob?.id).toBe("j");
  });

  test("latest prefers the default branch over a newer feature branch", () => {
    const out = buildRepoCatalog(
      [atelier],
      [
        prebuild("snap-feat", atelier.cloneUrl, "2026-09-03", "feat"),
        prebuild("snap-main", atelier.cloneUrl, "2026-09-01", "main"),
      ],
      [],
    );
    expect(out[0]?.latest?.ref).toBe("snap-main");
    expect(out[0]?.prebuilds).toHaveLength(2);

    const onlyFeat = buildRepoCatalog(
      [atelier],
      [prebuild("snap-feat", atelier.cloneUrl, "2026-09-03", "feat")],
      [],
    );
    expect(onlyFeat[0]?.latest?.ref).toBe("snap-feat");
  });
});

describe("filterCatalog / catalogCounts", () => {
  const entries = buildRepoCatalog(
    [
      repo("frak-id/atelier", { description: "Dev environments" }),
      repo("frak-id/wallet"),
      repo("me/old", { archived: true }),
      repo("me/react", { fork: true }),
    ],
    [prebuild("snap", "https://github.com/frak-id/atelier", "2026-09-01")],
    [],
  );

  test("hides archived + forks unless asked", () => {
    const names = (showHidden: boolean) =>
      filterCatalog(entries, { query: "", filter: "all", showHidden }).map(
        (e) => e.repo.name,
      );
    expect(names(false)).toEqual(["atelier", "wallet"]);
    expect(names(true)).toEqual(["atelier", "wallet", "old", "react"]);
  });

  test("filters by prebuild state and multi-term search", () => {
    const run = (filter: "all" | "needs" | "prebuilt", query = "") =>
      filterCatalog(entries, { query, filter, showHidden: false }).map(
        (e) => e.repo.name,
      );
    expect(run("needs")).toEqual(["wallet"]);
    expect(run("prebuilt")).toEqual(["atelier"]);
    expect(run("all", "FRAK  environments")).toEqual(["atelier"]);
    expect(run("all", "nothing-matches")).toEqual([]);
  });

  test("counts ignore search but respect visibility", () => {
    expect(catalogCounts(entries, false)).toEqual({
      all: 2,
      prebuilt: 1,
      needs: 1,
    });
    expect(catalogCounts(entries, true).all).toBe(4);
  });
});
