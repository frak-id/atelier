/**
 * dev-base's gh wrapper (`/usr/local/bin/gh`) reads the token from the
 * credential file this module writes, so both must agree on its path and
 * line format. These tests run the real wrapper script against that file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGitAttributionFiles,
  GIT_CREDENTIALS_PATH,
} from "./git-attribution.ts";

const WRAPPER = join(
  import.meta.dir,
  "../../runtime/registry/seeds/dev-base/rootfs/usr/local/bin/gh",
);
const GH_BIN = "/usr/local/libexec/gh/gh";
const TOKEN = "ghs_abc123";

function credentialLine(token: string): string {
  const file = buildGitAttributionFiles({ githubToken: token }).find(
    (f) => f.path === GIT_CREDENTIALS_PATH,
  );
  if (typeof file?.content !== "string") throw new Error("no credential file");
  return file.content;
}

describe("dev-base gh wrapper", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Runs the wrapper with its two paths pointed into a temp dir, in front
   * of a fake gh that prints the token it was given and its arguments. */
  function run(opts: {
    credentials?: string;
    hostsYml?: string;
    env?: Record<string, string>;
    args?: string[];
  }): string {
    const root = mkdtempSync(join(tmpdir(), "atelier-gh-wrapper-"));
    dir = root;
    const fakeGh = join(root, "gh-real");
    writeFileSync(
      fakeGh,
      '#!/bin/sh\n[ -n "$GH_TOKEN" ] || GH_TOKEN=unset\necho "$GH_TOKEN $*"\n',
    );
    chmodSync(fakeGh, 0o755);
    const credentials = join(root, "git-credentials");
    if (opts.credentials !== undefined) {
      writeFileSync(credentials, opts.credentials);
    }
    if (opts.hostsYml !== undefined) {
      mkdirSync(join(root, ".config/gh"), { recursive: true });
      writeFileSync(join(root, ".config/gh/hosts.yml"), opts.hostsYml);
    }
    const script = readFileSync(WRAPPER, "utf8")
      .replace(`GH_BIN=${GH_BIN}\n`, `GH_BIN=${fakeGh}\n`)
      .replace(
        `CREDENTIALS=${GIT_CREDENTIALS_PATH}\n`,
        `CREDENTIALS=${credentials}\n`,
      );
    const out = spawnSync(
      "sh",
      ["-c", script, "gh", ...(opts.args ?? ["pr", "list"])],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: root, ...opts.env },
      },
    );
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    return out.stdout.trim();
  }

  test("reads the file the server writes and runs the real binary", () => {
    const source = readFileSync(WRAPPER, "utf8");
    expect(source).toContain(`\nCREDENTIALS=${GIT_CREDENTIALS_PATH}\n`);
    expect(source).toContain(`\nGH_BIN=${GH_BIN}\n`);
  });

  test("hands gh the token git uses", () => {
    expect(run({ credentials: credentialLine(TOKEN) })).toBe(
      `${TOKEN} pr list`,
    );
    // git's store helper may add other hosts to the file.
    const mixed = `https://u:p@gitlab.com\n${credentialLine(TOKEN)}`;
    expect(run({ credentials: mixed })).toBe(`${TOKEN} pr list`);
  });

  test("a token the caller set wins", () => {
    const credentials = credentialLine(TOKEN);
    expect(run({ credentials, env: { GH_TOKEN: "mine" } })).toBe(
      "mine pr list",
    );
    expect(run({ credentials, env: { GITHUB_TOKEN: "mine" } })).toBe(
      "unset pr list",
    );
  });

  test("a gh login for github.com wins, one for another host does not", () => {
    const credentials = credentialLine(TOKEN);
    const login = "github.com:\n    user: someone\n";
    expect(run({ credentials, hostsYml: login })).toBe("unset pr list");
    const enterprise = "ghe.example.com:\n    user: someone\n";
    expect(run({ credentials, hostsYml: enterprise })).toBe(`${TOKEN} pr list`);
  });

  test("no token when the credential file is missing or empty", () => {
    expect(run({})).toBe("unset pr list");
    expect(run({ credentials: "" })).toBe("unset pr list");
  });

  test("gh auth login and friends never get the token", () => {
    const credentials = credentialLine(TOKEN);
    for (const sub of ["login", "logout", "refresh", "switch"]) {
      expect(run({ credentials, args: ["auth", sub] })).toBe(
        `unset auth ${sub}`,
      );
    }
    expect(run({ credentials, args: ["auth", "status"] })).toBe(
      `${TOKEN} auth status`,
    );
  });
});
