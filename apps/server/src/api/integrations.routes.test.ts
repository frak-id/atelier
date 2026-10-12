/**
 * `/api/integrations` through the real routes and a real database (mock
 * mode: any token is the fixed mock user). The registry is built from a fake
 * environment; the hub's behaviour is tested in `integrations/hub.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IntegrationConnectionView,
  IntegrationView,
} from "@frak/atelier-shared";
import { Elysia } from "elysia";
import type { ControlContainer } from "../control/index.ts";
import type { Integration } from "../integrations/index.ts";

process.env.ATELIER_SERVER_MODE = "mock";

/** The user every token resolves to in mock mode. */
const MOCK_USER_ID = "12345";

let dataDir: string;
let app: Elysia;
let control: ControlContainer;

const integrations: Integration[] = [
  {
    manifest: {
      id: "full",
      label: "Full",
      description: "has everything",
      credential: { label: "Full API key", required: true },
    },
    onPermission: async () => {},
  },
  { manifest: { id: "plain", label: "Plain", description: "nothing" } },
  { manifest: { id: "off", label: "Off", description: "disabled" } },
];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-integrations-routes-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../control/index.ts");
  const { createIntegrationRegistry } = await import(
    "../integrations/index.ts"
  );
  const { SandboxError } = await import("../shared/errors.ts");
  const { createIntegrationsRoutes } = await import("./integrations.routes.ts");
  control = createControlContainer();
  const container = {
    control,
    integrations: createIntegrationRegistry(integrations, {
      ATELIER_INTEGRATION_FULL: "true",
      ATELIER_INTEGRATION_PLAIN: "1",
    }),
  } as unknown as Parameters<typeof createIntegrationsRoutes>[0];
  app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof SandboxError) {
        set.status = error.statusCode;
        return { error: error.code, message: error.message };
      }
    })
    .use(createIntegrationsRoutes(container)) as unknown as Elysia;
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const headers = {
  authorization: "Bearer test",
  "content-type": "application/json",
};

function call(method: string, path: string, body?: unknown) {
  return app.handle(
    new Request(`http://localhost/api/integrations${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function list(): Promise<IntegrationView[]> {
  return (await call("GET", "/")).json() as Promise<IntegrationView[]>;
}

describe("/api/integrations", () => {
  test("lists enabled integrations with manifest and capabilities", async () => {
    const views = await list();
    expect(views.map((v) => v.id)).toEqual(["full", "plain"]);
    expect(views[0]).toMatchObject({
      label: "Full",
      credential: { label: "Full API key", required: true },
      capabilities: { permissions: true },
      connection: null,
    });
    expect(views[1]).toMatchObject({
      capabilities: { permissions: false },
      connection: null,
    });
  });

  test("an unknown or disabled id is a 404", async () => {
    for (const id of ["off", "nope"]) {
      expect((await call("PUT", `/${id}/connection`, {})).status).toBe(404);
    }
  });

  test("disconnect cleans up a disabled catalog id, 404s an unknown one", async () => {
    await control.integrationConnectionService.upsert(MOCK_USER_ID, "off", {});
    expect((await call("DELETE", "/off/connection")).status).toBe(204);
    expect(
      control.integrationConnectionService.get(MOCK_USER_ID, "off"),
    ).toBeUndefined();
    expect((await call("DELETE", "/nope/connection")).status).toBe(404);
  });

  test("a credential for an integration that declares none is a 400", async () => {
    const res = await call("PUT", "/plain/connection", { credential: "x" });
    expect(res.status).toBe(400);
    expect(
      control.integrationConnectionService.get(MOCK_USER_ID, "plain"),
    ).toBeUndefined();
  });

  test("a required credential must be present on create", async () => {
    expect((await call("PUT", "/full/connection", {})).status).toBe(400);
    expect(
      (await call("PUT", "/full/connection", { credential: null })).status,
    ).toBe(400);
    expect((await list())[0]?.connection).toBeNull();
  });

  test("connect never returns the credential; updating keeps it", async () => {
    const res = await call("PUT", "/full/connection", {
      credential: "sk-secret",
      minRisk: "medium",
      delaySeconds: 10,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text) as IntegrationConnectionView).toMatchObject({
      enabled: true,
      minRisk: "medium",
      delaySeconds: 10,
      hasCredential: true,
    });
    expect(text).not.toContain("sk-secret");
    expect(JSON.stringify(await list())).not.toContain("sk-secret");

    const updated = (await (
      await call("PUT", "/full/connection", { enabled: false })
    ).json()) as IntegrationConnectionView;
    expect(updated).toMatchObject({
      enabled: false,
      hasCredential: true,
      minRisk: "medium",
    });
  });

  test("a connection without a credential is fine when none is declared", async () => {
    const res = await call("PUT", "/plain/connection", {});
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as IntegrationConnectionView).hasCredential,
    ).toBe(false);
  });

  test("disconnect deletes the connection, idempotently", async () => {
    expect((await call("DELETE", "/full/connection")).status).toBe(204);
    expect((await list())[0]?.connection).toBeNull();
    expect((await call("DELETE", "/full/connection")).status).toBe(204);
  });
});
