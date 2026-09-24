import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  autostartProcesses,
  LAUNCHPAD_STARTER_ANNOTATION,
  type LaunchpadService,
  resolveWorkspaceServices,
  StarterInputSchema,
  StarterPatchSchema,
  starterInputProblems,
  starterLaunchRequest,
  workspacePhase,
} from "./launchpad-spec.ts";
import type { SandboxUrl } from "./runtime-api.ts";

const URLS: SandboxUrl[] = [
  {
    name: "pi",
    url: "https://pi-abc.example.dev",
    processes: ["pi-web-sessiond", "pi"],
    ready: false,
  },
  {
    name: "web",
    url: "https://web-abc.example.dev/",
    processes: ["dev"],
    ready: true,
  },
  { name: "vscode", url: "https://vscode-abc.example.dev" },
  { name: "ssh", url: "ssh abc@ssh.example.dev" },
];

const recipe = {
  source: { image: "dev-base" },
  resources: { vcpus: 2, memoryMb: 4096 },
};

describe("StarterInputSchema", () => {
  test("accepts a complete starter", () => {
    const input = {
      title: "Landing page copy",
      description: "Tweak the marketing site with the pi agent",
      icon: "megaphone",
      guide: "Open Pi, describe your change, check the preview.",
      published: true,
      recipe: {
        ...recipe,
        toolboxes: ["tb/org/o1/pi-stack"],
        prebuild: {
          source: { image: "dev-base" },
          repos: [{ url: "https://github.com/acme/site", clonePath: "site" }],
        },
      },
      services: [
        { id: "agent", label: "Pi", target: { port: "pi" } },
        {
          id: "preview",
          label: "Preview",
          target: { port: "web", path: "/fr" },
          open: "external",
          autostart: false,
        },
        {
          id: "staging",
          label: "Staging",
          target: { url: "https://staging.acme.dev/?sb={sandboxId}" },
        },
      ],
    };
    expect(Value.Check(StarterInputSchema, input)).toBe(true);
  });

  test("rejects a bad service id, a relative path and a non-http link", () => {
    const base = { title: "t", description: "", recipe, services: [] };
    const bad = (service: unknown) =>
      Value.Check(StarterInputSchema, { ...base, services: [service] });
    expect(bad({ id: "Bad Id", label: "x", target: { port: "web" } })).toBe(
      false,
    );
    expect(
      bad({ id: "ok", label: "x", target: { port: "web", path: "admin" } }),
    ).toBe(false);
    expect(
      bad({ id: "ok", label: "x", target: { url: "javascript:alert(1)" } }),
    ).toBe(false);
  });

  test("a patch may carry any subset of fields", () => {
    expect(Value.Check(StarterPatchSchema, { title: "renamed" })).toBe(true);
    expect(Value.Check(StarterPatchSchema, { nope: 1 })).toBe(false);
  });

  test("duplicate service ids are reported", () => {
    const services: LaunchpadService[] = [
      { id: "a", label: "A", target: { port: "web" } },
      { id: "a", label: "A2", target: { port: "pi" } },
    ];
    expect(starterInputProblems({ services })).toEqual([
      'Duplicate service id "a"',
    ]);
    expect(starterInputProblems({ services: services.slice(0, 1) })).toEqual(
      [],
    );
  });
});

describe("resolveWorkspaceServices", () => {
  test("resolves port targets (with path) and link targets", () => {
    const services: LaunchpadService[] = [
      { id: "agent", label: "Pi", icon: "bot", target: { port: "pi" } },
      {
        id: "preview",
        label: "Preview",
        target: { port: "web", path: "/fr" },
        open: "external",
      },
      {
        id: "staging",
        label: "Staging",
        target: { url: "https://staging.acme.dev/{sandboxId}/x" },
      },
      { id: "missing", label: "Nope", target: { port: "grafana" } },
    ];
    expect(resolveWorkspaceServices(services, URLS, "abc")).toEqual([
      {
        id: "agent",
        label: "Pi",
        icon: "bot",
        open: "embed",
        kind: "port",
        url: "https://pi-abc.example.dev",
        processes: ["pi-web-sessiond", "pi"],
        ready: false,
      },
      {
        id: "preview",
        label: "Preview",
        open: "external",
        kind: "port",
        url: "https://web-abc.example.dev/fr",
        processes: ["dev"],
        ready: true,
      },
      {
        id: "staging",
        label: "Staging",
        open: "embed",
        kind: "link",
        url: "https://staging.acme.dev/abc/x",
      },
      { id: "missing", label: "Nope", open: "embed", kind: "port" },
    ]);
  });

  test("no declared services falls back to every web url, minus ssh", () => {
    const resolved = resolveWorkspaceServices([], URLS, "abc");
    expect(resolved.map((s) => s.id)).toEqual(["pi", "web", "vscode"]);
    expect(resolved.every((s) => s.open === "embed")).toBe(true);
  });
});

describe("autostartProcesses", () => {
  test("starts the gating processes of not-ready port services only", () => {
    const services: LaunchpadService[] = [
      { id: "agent", label: "Pi", target: { port: "pi" } },
      // Already ready: nothing to start.
      { id: "preview", label: "Preview", target: { port: "web" } },
      // Opted out.
      {
        id: "code",
        label: "Code",
        target: { port: "vscode" },
        autostart: false,
      },
      { id: "link", label: "Link", target: { url: "https://x.dev" } },
      // Duplicate port: processes deduped.
      { id: "agent-2", label: "Pi again", target: { port: "pi" } },
    ];
    expect(autostartProcesses(services, URLS)).toEqual([
      "pi-web-sessiond",
      "pi",
    ]);
  });

  test("undeclared services never autostart", () => {
    expect(autostartProcesses([], URLS)).toEqual([]);
  });
});

describe("workspacePhase", () => {
  test("a running record is ready, whatever the job says", () => {
    expect(workspacePhase("running", "running")).toBe("ready");
    expect(workspacePhase("running", "failed")).toBe("ready");
  });

  test("an active job means preparing (no record) or starting (waking)", () => {
    expect(workspacePhase(undefined, "queued")).toBe("preparing");
    expect(workspacePhase(undefined, "running")).toBe("preparing");
    // A resuming sandbox stays `paused` until it's back.
    expect(workspacePhase("paused", "running")).toBe("starting");
    expect(workspacePhase("error", "running")).toBe("starting");
    expect(workspacePhase("creating", "running")).toBe("starting");
  });

  test("a settled job defers to the record", () => {
    expect(workspacePhase("paused", undefined)).toBe("sleeping");
    // A failed wake-up restores the paused record: still asleep.
    expect(workspacePhase("paused", "failed")).toBe("sleeping");
    expect(workspacePhase("stopped", "succeeded")).toBe("sleeping");
    expect(workspacePhase("error", "failed")).toBe("failed");
    expect(workspacePhase("creating", undefined)).toBe("starting");
  });

  test("no record: failed launch, or gone", () => {
    expect(workspacePhase(undefined, "failed")).toBe("failed");
    expect(workspacePhase(undefined, "canceled")).toBe("failed");
    expect(workspacePhase(undefined, "succeeded")).toBe("gone");
    expect(workspacePhase(undefined, undefined)).toBe("gone");
  });
});

describe("starterLaunchRequest", () => {
  test("stamps the title and the starter annotation, keeps the recipe", () => {
    const request = starterLaunchRequest(
      {
        id: "st1",
        recipe: {
          ...recipe,
          metadata: { team: "growth" },
          annotations: { "atelier.dev/harness": "pi" },
          toolboxes: ["tb/org/o1/pi-stack"],
        },
      },
      "Spring campaign",
    );
    expect(request).toEqual({
      ...recipe,
      toolboxes: ["tb/org/o1/pi-stack"],
      metadata: { team: "growth", name: "Spring campaign" },
      annotations: {
        "atelier.dev/harness": "pi",
        [LAUNCHPAD_STARTER_ANNOTATION]: "st1",
      },
    });
  });
});
