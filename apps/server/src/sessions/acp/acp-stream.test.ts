import { describe, expect, test } from "bun:test";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { scopeToConnection } from "./acp-stream.ts";

/** An in-memory inner stream: what the scoped side writes lands in `sent`,
 * and `deliver` plays agent output into it. */
function harness() {
  const sent: AnyMessage[] = [];
  let push!: ReadableStreamDefaultController<AnyMessage>;
  const inner: Stream = {
    writable: new WritableStream<AnyMessage>({
      write(message) {
        sent.push(message);
      },
    }),
    readable: new ReadableStream<AnyMessage>({
      start(controller) {
        push = controller;
      },
    }),
  };
  const scoped = scopeToConnection(inner, "c1:");
  const writer = scoped.writable.getWriter();
  const reader = scoped.readable.getReader();
  return {
    sent,
    send: (message: AnyMessage) => writer.write(message),
    deliver: (message: AnyMessage) => push.enqueue(message),
    end: () => push.close(),
    async received(): Promise<AnyMessage[]> {
      const out: AnyMessage[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return out;
        out.push(value);
      }
    },
  };
}

const request = (id: number, method = "session/new"): AnyMessage => ({
  jsonrpc: "2.0",
  id,
  method,
  params: {},
});

describe("scopeToConnection", () => {
  test("tags request ids on the way out and restores them on the way back", async () => {
    const h = harness();
    await h.send(request(0, "initialize"));
    expect(h.sent).toEqual([
      { jsonrpc: "2.0", id: "c1:0", method: "initialize", params: {} },
    ]);
    h.deliver({ jsonrpc: "2.0", id: "c1:0", result: { ok: true } });
    h.end();
    expect(await h.received()).toEqual([
      { jsonrpc: "2.0", id: 0, result: { ok: true } },
    ]);
  });

  test("drops a replayed response that reuses this connection's numeric id", async () => {
    const h = harness();
    // What the bridge replays from an earlier connection: its initialize and
    // a failed session/new, both with ids this connection is about to reuse.
    h.deliver({ jsonrpc: "2.0", id: 0, result: { stale: true } });
    h.deliver({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Could not start pi" },
    });
    await h.send(request(0, "initialize"));
    await h.send(request(1));
    h.deliver({ jsonrpc: "2.0", id: "c1:0", result: { fresh: true } });
    h.deliver({ jsonrpc: "2.0", id: "c1:1", result: { sessionId: "s2" } });
    h.end();
    expect(await h.received()).toEqual([
      { jsonrpc: "2.0", id: 0, result: { fresh: true } },
      { jsonrpc: "2.0", id: 1, result: { sessionId: "s2" } },
    ]);
  });

  test("drops agent requests and notifications replayed ahead of our first response", async () => {
    const h = harness();
    const staleUpdate: AnyMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "old" },
    };
    const stalePermission: AnyMessage = {
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: { sessionId: "old" },
    };
    h.deliver(staleUpdate);
    h.deliver(stalePermission);
    await h.send(request(0, "initialize"));
    h.deliver({ jsonrpc: "2.0", id: "c1:0", result: {} });
    const liveUpdate: AnyMessage = {
      ...staleUpdate,
      params: { sessionId: "s" },
    };
    h.deliver(liveUpdate);
    h.end();
    expect(await h.received()).toEqual([
      { jsonrpc: "2.0", id: 0, result: {} },
      liveUpdate,
    ]);
  });

  test("leaves our responses to agent requests untouched", async () => {
    const h = harness();
    const reply: AnyMessage = { jsonrpc: "2.0", id: 7, result: {} };
    await h.send(reply);
    expect(h.sent).toEqual([reply]);
  });

  test("$/cancel_request names the wire id of an in-flight request", async () => {
    const h = harness();
    await h.send(request(3, "session/prompt"));
    await h.send({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: 3 },
    });
    expect(h.sent[1]).toEqual({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: "c1:0" },
    });
  });
});
