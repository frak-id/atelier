import { AGENT_PORT, VSOCK_PORT } from "./constants.ts";
import { handler } from "./router.ts";

try {
  Deno.serve(
    {
      transport: "vsock" as unknown as undefined,
      cid: 4294967295,
      port: VSOCK_PORT,
      onListen() {
        console.log(
          `[vsock] Sandbox agent listening on vsock port ${VSOCK_PORT}`,
        );
      },
    } as Parameters<typeof Deno.serve>[0],
    handler,
  );
} catch (err) {
  console.warn(
    `[vsock] Failed to start vsock listener: ${err instanceof Error ? err.message : err}`,
  );
}

Deno.serve(
  {
    port: AGENT_PORT,
    hostname: "0.0.0.0",
    onListen() {
      console.log(
        `[tcp] Sandbox agent listening on http://0.0.0.0:${AGENT_PORT}`,
      );
    },
  },
  handler,
);
