import { VSOCK_PORT } from "./constants.ts";
import { handler } from "./router.ts";

// deno-lint-ignore no-explicit-any
Deno.serve(
  {
    transport: "vsock",
    cid: 4294967295,
    port: VSOCK_PORT,
    onListen() {
      console.log(`Sandbox agent listening on vsock port ${VSOCK_PORT}`);
    },
  } as any,
  handler,
);
