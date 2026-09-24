import { describe, expect, test } from "bun:test";
import type { PrebuildRecord } from "./prebuild-spec.ts";
import {
  buildRepoPrebuildSpec,
  detectSetupSteps,
  findRepoBranchPrebuild,
  findRepoPrebuilds,
  normalizeBranch,
  parsePrebuildJobTarget,
  prebuildJobTarget,
  prebuildRepoFor,
  prebuildRepos,
  repoCloneName,
  repoKey,
  repoShortName,
} from "./repo-prebuild.ts";

function record(
  ref: string,
  url: string,
  branch?: string,
  extra: Partial<PrebuildRecord> = {},
): PrebuildRecord {
  return {
    ref,
    hash: `h-${ref}`,
    image: "dev-base:latest",
    createdAt: "2026-01-01T00:00:00.000Z",
    spec: {
      source: { image: "dev-base" },
      repos: [{ url, ...(branch ? { branch } : {}), clonePath: "repo" }],
    },
    ...extra,
  };
}

describe("repoKey", () => {
  test("https, scp and ssh spellings of one repo collapse to one key", () => {
    const keys = [
      "https://github.com/Frak-Id/Atelier",
      "https://github.com/frak-id/atelier.git",
      "https://github.com/frak-id/atelier/",
      "git@github.com:frak-id/atelier.git",
      "ssh://git@github.com/frak-id/atelier.git",
      "ssh://git@github.com:22/frak-id/atelier",
      "https://x-access-token:abc@github.com/frak-id/atelier",
    ].map(repoKey);
    expect(new Set(keys)).toEqual(new Set(["github.com/frak-id/atelier"]));
  });

  test("the host is part of the identity", () => {
    expect(repoKey("https://gitlab.com/frak-id/atelier")).not.toBe(
      repoKey("https://github.com/frak-id/atelier"),
    );
  });
});

describe("repoShortName / repoCloneName", () => {
  test("owner/name without host, casing preserved", () => {
    expect(repoShortName("https://github.com/Frak-Id/Atelier.git")).toBe(
      "Frak-Id/Atelier",
    );
    expect(repoShortName("git@github.com:frak-id/atelier.git")).toBe(
      "frak-id/atelier",
    );
    expect(repoShortName("not a url")).toBe("not a url");
  });

  test("clone name is the last segment", () => {
    expect(repoCloneName("https://github.com/frak-id/atelier.git")).toBe(
      "atelier",
    );
    expect(repoCloneName("git@github.com:frak-id/wallet")).toBe("wallet");
    expect(repoCloneName("")).toBe("repo");
  });
});

describe("prebuildJobTarget", () => {
  test("url#branch per repo, falling back to the source", () => {
    expect(
      prebuildJobTarget({
        source: { image: "dev-base" },
        repos: [
          { url: "https://github.com/a/b", branch: "dev", clonePath: "b" },
          { url: "https://github.com/a/c", clonePath: "c" },
        ],
      }),
    ).toBe("https://github.com/a/b#dev, https://github.com/a/c");
    expect(prebuildJobTarget({ source: { snapshot: "snap-1" } })).toBe(
      "snap-1",
    );
  });
});

describe("parsePrebuildJobTarget", () => {
  test("inverts prebuildJobTarget into repo keys + branches", () => {
    const target = prebuildJobTarget({
      source: { image: "dev-base" },
      repos: [
        { url: "git@github.com:A/B.git", branch: "feat/x", clonePath: "b" },
        { url: "https://github.com/a/c", clonePath: "c" },
      ],
    });
    expect(parsePrebuildJobTarget(target)).toEqual([
      { key: "github.com/a/b", branch: "feat/x" },
      { key: "github.com/a/c", branch: undefined },
    ]);
  });

  test("empty and blank targets parse to nothing", () => {
    expect(parsePrebuildJobTarget(undefined)).toEqual([]);
    expect(parsePrebuildJobTarget("")).toEqual([]);
  });
});

describe("normalizeBranch", () => {
  test("the default branch and blanks collapse to undefined", () => {
    expect(normalizeBranch("main", "main")).toBeUndefined();
    expect(normalizeBranch(" main ", "main")).toBeUndefined();
    expect(normalizeBranch("", "main")).toBeUndefined();
    expect(normalizeBranch(undefined, "main")).toBeUndefined();
    expect(normalizeBranch(" dev ", "main")).toBe("dev");
  });

  test("case-sensitive, like git", () => {
    expect(normalizeBranch("Main", "main")).toBe("Main");
  });

  test("without a default-branch hint only blanks collapse", () => {
    expect(normalizeBranch("main")).toBe("main");
    expect(normalizeBranch("  ")).toBeUndefined();
  });
});

describe("findRepoPrebuilds / findRepoBranchPrebuild", () => {
  const rows = [
    record("snap-new", "https://github.com/frak-id/atelier.git", "main"),
    record("snap-dev", "git@github.com:frak-id/atelier.git", "dev"),
    record("snap-default", "https://github.com/frak-id/atelier"),
    record("snap-other", "https://github.com/frak-id/wallet"),
    // A spec-less (hand-made) snapshot: its metadata never identifies a repo.
    {
      ref: "snap-meta",
      hash: "h",
      image: "dev-base:latest",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { repo: "https://github.com/frak-id/meta", branch: "main" },
    },
  ];

  test("all branches of a repo, in input order", () => {
    expect(
      findRepoPrebuilds(rows, "https://github.com/FRAK-ID/atelier").map(
        (r) => r.ref,
      ),
    ).toEqual(["snap-new", "snap-dev", "snap-default"]);
    expect(findRepoPrebuilds(rows, "https://github.com/frak-id/meta")).toEqual(
      [],
    );
  });

  test("exact branch match without a default-branch hint", () => {
    const url = "https://github.com/frak-id/atelier";
    expect(findRepoBranchPrebuild(rows, url, "dev")?.ref).toBe("snap-dev");
    expect(findRepoBranchPrebuild(rows, url)?.ref).toBe("snap-default");
    expect(findRepoBranchPrebuild(rows, url, "main")?.ref).toBe("snap-new");
    expect(findRepoBranchPrebuild(rows, url, "nope")).toBeUndefined();
  });

  test("default-branch hint equates an omitted branch with it", () => {
    const url = "https://github.com/frak-id/atelier";
    // newest-first: the explicit `main` bake wins over the implicit one
    expect(findRepoBranchPrebuild(rows, url, undefined, "main")?.ref).toBe(
      "snap-new",
    );
    const onlyImplicit = rows.filter((r) => r.ref !== "snap-new");
    expect(findRepoBranchPrebuild(onlyImplicit, url, "main", "main")?.ref).toBe(
      "snap-default",
    );
  });
});

describe("multi-repo prebuilds", () => {
  const multi: PrebuildRecord = {
    ref: "snap-multi",
    hash: "h-multi",
    image: "dev-base:latest",
    createdAt: "2026-02-01T00:00:00.000Z",
    spec: {
      source: { image: "dev-base" },
      repos: [
        { url: "https://github.com/frak-id/wallet", clonePath: "wallet" },
        {
          url: "git@github.com:frak-id/atelier.git",
          branch: "dev",
          clonePath: "code/atelier",
        },
      ],
    },
  };
  const url = "https://github.com/frak-id/atelier";

  test("every repo counts, not just the first", () => {
    expect(prebuildRepos(multi).map((r) => r.clonePath)).toEqual([
      "wallet",
      "code/atelier",
    ]);
    expect(prebuildRepoFor(multi, url)?.clonePath).toBe("code/atelier");
    expect(prebuildRepoFor(multi, "https://github.com/frak-id/nope")).toBe(
      undefined,
    );
    expect(findRepoPrebuilds([multi], url).map((r) => r.ref)).toEqual([
      "snap-multi",
    ]);
  });

  test("branch matching uses that repo's own branch", () => {
    expect(findRepoBranchPrebuild([multi], url, "dev")?.ref).toBe("snap-multi");
    expect(findRepoBranchPrebuild([multi], url)).toBeUndefined();
  });

  test("a dedicated repo prebuild wins over a newer multi-repo one", () => {
    const dedicated = record("snap-solo", `${url}.git`, "dev");
    // newest-first input: the multi-repo bake is the newer one
    expect(findRepoBranchPrebuild([multi, dedicated], url, "dev")?.ref).toBe(
      "snap-solo",
    );
  });
});

describe("detectSetupSteps", () => {
  const from = (files: string[]) => {
    const set = new Set(files);
    return detectSetupSteps((f) => set.has(f));
  };

  test("node package manager from lockfile", () => {
    expect(from(["package.json", "bun.lock"])).toEqual(["bun install"]);
    expect(from(["package.json", "pnpm-lock.yaml"])).toEqual([
      "pnpm install --frozen-lockfile",
    ]);
    expect(from(["package.json", "package-lock.json"])).toEqual(["npm ci"]);
    expect(from(["package.json"])).toEqual(["npm install"]);
  });

  test("multi-stack repos yield one step per ecosystem", () => {
    expect(
      from(["package.json", "yarn.lock", "Cargo.toml", "poetry.lock"]),
    ).toEqual([
      "yarn install --frozen-lockfile",
      "poetry install",
      "cargo fetch",
    ]);
    expect(from(["README.md"])).toEqual([]);
  });
});

describe("buildRepoPrebuildSpec", () => {
  test("scopes steps to the clone path, without metadata", () => {
    expect(
      buildRepoPrebuildSpec({
        repo: " https://github.com/frak-id/atelier ",
        branch: "dev",
        image: "dev-base",
        build: ["bun install", " ", "cd other && make"],
      }),
    ).toEqual({
      source: { image: "dev-base" },
      repos: [
        {
          url: "https://github.com/frak-id/atelier",
          branch: "dev",
          clonePath: "atelier",
        },
      ],
      build: ["cd atelier && bun install", "cd other && make"],
    });
  });

  test("default branch and no steps stay omitted", () => {
    const spec = buildRepoPrebuildSpec({
      repo: "https://github.com/frak-id/atelier",
      branch: "  ",
      image: "dev-base",
      clonePath: "work/atelier",
    });
    expect(spec.repos?.[0]).toEqual({
      url: "https://github.com/frak-id/atelier",
      clonePath: "work/atelier",
    });
    expect(spec.build).toBeUndefined();
    expect(spec.metadata).toBeUndefined();
  });
});
