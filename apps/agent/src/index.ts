import { VSOCK_PORT } from "./constants.ts";
import { handler } from "./router.ts";

Deno.serve(
  {
    transport: "vsock" as unknown as undefined,
    cid: 4294967295,
    port: VSOCK_PORT,
    onListen() {
      console.log(`Sandbox agent listening on vsock port ${VSOCK_PORT}`);
    },
  } as Parameters<typeof Deno.serve>[0],
  handler,
);
