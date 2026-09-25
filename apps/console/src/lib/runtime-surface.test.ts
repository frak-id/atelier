import { describe, expect, test } from "bun:test";
import type { RuntimeSurface } from "@atelier/spec";
import {
  addPort,
  addService,
  exposureOf,
  portIssues,
  processIssues,
  processWarnings,
  removeService,
  setPortExposure,
  setServicePort,
  surfaceRows,
  surfaceValid,
  updateProcess,
} from "./runtime-surface.ts";

/** The browser toolbox: three chained processes, one port gated by the
 * first one's readiness (no same-name process). */
const BROWSER: RuntimeSurface = {
  processes: [
    { name: "kasmvnc", command: "Xvnc", lazy: true, readiness: { port: 6080 } },
    { name: "openbox", command: "openbox", lazy: true, after: ["kasmvnc"] },
    { name: "chromium", command: "chromium", lazy: true, after: ["openbox"] },
  ],
  ports: [{ name: "browser", port: 6080, public: true, auth: "forward" }],
};

const DEV: RuntimeSurface = {
  processes: [
    {
      name: "web",
      command: "bun run dev",
      cwd: "/home/dev/app",
      readiness: { port: 5173 },
    },
    { name: "worker", command: "bun run worker", after: ["web"] },
  ],
  ports: [{ name: "web", port: 5173, public: true, auth: "forward" }],
};

describe("surfaceRows", () => {
  test("links a process to its same-name port", () => {
    const rows = surfaceRows(DEV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "service",
      processIndex: 0,
      portIndex: 0,
    });
    expect(rows[1]).toMatchObject({ kind: "service", processIndex: 1 });
    expect(rows[1]).not.toHaveProperty("port");
  });

  test("an unclaimed port is its own row, with what gates it", () => {
    const rows = surfaceRows(BROWSER);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({
      kind: "port",
      portIndex: 0,
      gatedBy: ["kasmvnc"],
    });
  });

  test("a duplicate port name stays unlinked", () => {
    const rows = surfaceRows({
      processes: [{ name: "web", command: "x" }],
      ports: [
        { name: "web", port: 1 },
        { name: "web", port: 2 },
      ],
    });
    expect(rows.map((r) => r.kind)).toEqual(["service", "port"]);
  });
});

describe("exposure", () => {
  test("round-trips through the three levels", () => {
    const surface: RuntimeSurface = { ports: [{ name: "web", port: 3000 }] };
    const set = (s: RuntimeSurface, e: "private" | "login" | "open") =>
      setPortExposure(s, 0, e);
    expect(exposureOf({ name: "web", port: 3000 })).toBe("private");
    const login = set(surface, "login");
    expect(exposureOf(login.ports?.[0] ?? { name: "", port: 0 })).toBe("login");
    expect(set(surface, "open").ports?.[0]).toEqual({
      name: "web",
      port: 3000,
      public: true,
      auth: "none",
    });
    expect(set(login, "private")).toEqual(surface);
  });

  test("public without auth reads as open (no forward-auth annotations)", () => {
    expect(exposureOf({ name: "a", port: 1, public: true })).toBe("open");
  });
});

describe("updateProcess", () => {
  test("a rename carries the served port and after references", () => {
    const next = updateProcess(DEV, 0, { name: "app" });
    expect(next.processes?.[0]?.name).toBe("app");
    expect(next.ports?.[0]?.name).toBe("app");
    expect(next.processes?.[1]?.after).toEqual(["app"]);
  });

  test("renaming off a duplicate name leaves the other's references", () => {
    // worker renamed onto "web" (a clash), then on to "watcher".
    const clash = updateProcess(DEV, 1, { name: "web" });
    const next = updateProcess(clash, 1, { name: "watcher" });
    expect(next.processes?.[1]).toEqual({
      name: "watcher",
      command: "bun run worker",
      after: ["web"],
    });
    expect(next.ports?.[0]?.name).toBe("web");
  });

  test("clearing a field drops the key", () => {
    const next = updateProcess(DEV, 0, { cwd: undefined });
    expect(next.processes?.[0]).not.toHaveProperty("cwd");
  });

  test("keeps keys the form doesn't show", () => {
    const surface: RuntimeSurface = {
      processes: [
        { name: "acp", command: "x", stdio: "bridge", primary: true },
      ],
    };
    expect(updateProcess(surface, 0, { command: "y" }).processes?.[0]).toEqual({
      name: "acp",
      command: "y",
      stdio: "bridge",
      primary: true,
    });
  });
});

describe("setServicePort", () => {
  test("a readiness probe on the old port follows the new one", () => {
    const next = setServicePort(DEV, 0, 3000);
    expect(next.ports?.[0]?.port).toBe(3000);
    expect(next.processes?.[0]?.readiness).toEqual({ port: 3000 });
  });

  test("serving a new port adds it behind login, with a probe", () => {
    const next = setServicePort(DEV, 1, 4000);
    expect(next.ports?.[1]).toEqual({
      name: "worker",
      port: 4000,
      public: true,
      auth: "forward",
    });
    expect(next.processes?.[1]?.readiness).toEqual({ port: 4000 });
  });

  test("an explicit http readiness is left alone", () => {
    const surface: RuntimeSurface = {
      processes: [{ name: "a", command: "x", readiness: { http: "/health" } }],
    };
    const next = setServicePort(surface, 0, 8000);
    expect(next.processes?.[0]?.readiness).toEqual({ http: "/health" });
  });

  test("clearing drops the port and its probe", () => {
    const next = setServicePort(DEV, 0, undefined);
    expect(next.ports).toBeUndefined();
    expect(next.processes?.[0]).not.toHaveProperty("readiness");
  });
});

describe("removeService", () => {
  test("drops the process, its port and after references", () => {
    const next = removeService(DEV, 0);
    expect(next.processes).toEqual([
      { name: "worker", command: "bun run worker" },
    ]);
    expect(next.ports).toBeUndefined();
  });
});

describe("add", () => {
  test("addService picks a free name and port", () => {
    const next = addService(DEV, { user: "dev", port: 5173 });
    const added = next.processes?.at(-1);
    expect(added).toMatchObject({ name: "web-2", user: "dev" });
    expect(next.ports?.at(-1)).toMatchObject({ name: "web-2", port: 5174 });
    expect(added?.readiness).toEqual({ port: 5174 });
  });

  test("addService without a port adds just a process", () => {
    const next = addService({}, {});
    expect(next.processes).toEqual([{ name: "web", command: "" }]);
    expect(next.ports).toBeUndefined();
  });

  test("addPort appends a login-gated port", () => {
    expect(addPort({}).ports).toEqual([
      { name: "port", port: 8080, public: true, auth: "forward" },
    ]);
  });
});

describe("validation", () => {
  test("the shipped shapes are valid", () => {
    expect(surfaceValid(DEV)).toBe(true);
    expect(surfaceValid(BROWSER)).toBe(true);
    expect(surfaceValid({})).toBe(true);
  });

  test("duplicate and URL-unsafe names block", () => {
    const surface: RuntimeSurface = {
      processes: [
        { name: "web", command: "a" },
        { name: "web", command: "b" },
        { name: "My App", command: "c" },
      ],
      ports: [{ name: "My App", port: 3000, public: true }],
    };
    expect(processIssues(surface, 1).name).toContain("already named");
    expect(processIssues(surface, 2).name).toContain("lowercase");
    expect(surfaceValid(surface)).toBe(false);
  });

  test("a private port's name isn't a hostname", () => {
    expect(portIssues({ ports: [{ name: "My_Port", port: 1 }] }, 0)).toEqual(
      {},
    );
  });

  test("port numbers and empty commands block", () => {
    const surface: RuntimeSurface = {
      processes: [{ name: "a", command: " " }],
      ports: [{ name: "b", port: 0 }],
    };
    expect(processIssues(surface, 0).command).toBeDefined();
    expect(portIssues(surface, 0).port).toBeDefined();
  });

  test("an http readiness path needs a served port", () => {
    const path: RuntimeSurface = {
      processes: [{ name: "a", command: "x", readiness: { http: "/up" } }],
    };
    expect(processIssues(path, 0).readiness).toBeDefined();
    const served = { ...path, ports: [{ name: "a", port: 3000 }] };
    expect(processIssues(served, 0).readiness).toBeUndefined();
    const url = updateProcess(path, 0, {
      readiness: { http: "http://127.0.0.1:9/up" },
    });
    expect(processIssues(url, 0).readiness).toBeUndefined();
  });

  test("warns when readiness probes another port than the served one", () => {
    const surface = updateProcess(DEV, 0, { readiness: { port: 9999 } });
    expect(processWarnings(surface, 0)[0]).toContain("9999");
  });

  test("warns on an after reference declared elsewhere", () => {
    const surface: RuntimeSurface = {
      processes: [{ name: "a", command: "x", after: ["terminal"] }],
    };
    expect(processWarnings(surface, 0)[0]).toContain('"terminal"');
    expect(surfaceValid(surface)).toBe(true);
  });
});
