/**
 * Existence checks must only ever read a 404 as "absent". Callers make
 * destructive decisions from them — `resume` derives "no PVC, boot a blank
 * one" from `resourceExists` — so an API blip (e.g. the k3s restart during a
 * kata-deploy upgrade) must surface as an error, never as "not there".
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

process.env.ATELIER_SERVER_MODE = "mock";

const { config } = await import("../../shared/lib/config.ts");
const { KubeApiError, KubeClient } = await import("./kube.client.ts");

// The client short-circuits every call under mock mode; these tests exercise
// the real code paths with `get`/`request` stubbed, so run them as production.
let previousMode: typeof config.server.mode;
beforeEach(() => {
  previousMode = config.server.mode;
  config.server.mode = "production";
});

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  config.server.mode = previousMode;
});

function client() {
  return new KubeClient({ kubeconfig: "/nonexistent", namespace: "ns" });
}

function failGet(c: InstanceType<typeof KubeClient>, err: Error) {
  spies.push(spyOn(c, "get").mockRejectedValue(err));
}

const notFound = () => new KubeApiError("not found", 404, "NotFound");
const unavailable = () => new KubeApiError("connection refused", 503);

describe("resourceExists", () => {
  test("found → true", async () => {
    const c = client();
    spies.push(spyOn(c, "get").mockResolvedValue({}));
    expect(await c.resourceExists("PersistentVolumeClaim", "pvc")).toBe(true);
  });

  test("404 → false", async () => {
    const c = client();
    failGet(c, notFound());
    expect(await c.resourceExists("PersistentVolumeClaim", "pvc")).toBe(false);
  });

  test("API unavailable → throws (never reads as absent)", async () => {
    const c = client();
    failGet(c, unavailable());
    await expect(
      c.resourceExists("PersistentVolumeClaim", "pvc"),
    ).rejects.toThrow("connection refused");
  });

  test("403 → throws", async () => {
    const c = client();
    failGet(c, new KubeApiError("forbidden", 403, "Forbidden"));
    await expect(c.resourceExists("Pod", "p")).rejects.toThrow("forbidden");
  });
});

describe("getResource", () => {
  test("404 → null", async () => {
    const c = client();
    failGet(c, notFound());
    expect(await c.getResource("PersistentVolumeClaim", "pvc")).toBeNull();
  });

  test("API unavailable → throws", async () => {
    const c = client();
    failGet(c, unavailable());
    await expect(c.getResource("PersistentVolumeClaim", "pvc")).rejects.toThrow(
      "connection refused",
    );
  });
});

describe("waitForResourceDeleted", () => {
  test("keeps polling through a transient error, then sees the 404", async () => {
    const c = client();
    const get = spyOn(c, "get")
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(notFound());
    spies.push(get);
    const gone = await c.waitForResourceDeleted("Pod", "p", {
      timeout: 5_000,
      pollIntervalMs: 1,
    });
    expect(gone).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("an API that never answers is NOT reported as deleted", async () => {
    const c = client();
    failGet(c, unavailable());
    const gone = await c.waitForResourceDeleted("Pod", "p", {
      timeout: 30,
      pollIntervalMs: 5,
    });
    expect(gone).toBe(false);
  });
});

describe("deleteResource preconditions", () => {
  test("sends DeleteOptions with the uid precondition", async () => {
    const c = client();
    const request = spyOn(
      c as unknown as { request: (...args: unknown[]) => Promise<unknown> },
      "request",
    ).mockResolvedValue({});
    spies.push(request);
    await c.deleteResource("PersistentVolumeClaim", "pvc", undefined, {
      preconditions: { uid: "uid-1" },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/v1/namespaces/ns/persistentvolumeclaims/pvc",
      {
        method: "DELETE",
        body: {
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: "uid-1" },
        },
      },
    );
  });

  test("no options → plain DELETE, no body", async () => {
    const c = client();
    const request = spyOn(
      c as unknown as { request: (...args: unknown[]) => Promise<unknown> },
      "request",
    ).mockResolvedValue({});
    spies.push(request);
    await c.deleteResource("Pod", "p");
    expect(request).toHaveBeenCalledWith("/api/v1/namespaces/ns/pods/p", {
      method: "DELETE",
    });
  });
});
