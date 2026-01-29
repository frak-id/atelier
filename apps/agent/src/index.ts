import { VSOCK_PORT } from "./constants.ts";
import { handler } from "./router.ts";

async function startServer(): Promise<void> {
  while (true) {
    try {
      // deno-lint-ignore no-explicit-any
      const server = Deno.serve(
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
      await server.finished;
      console.log("Server closed unexpectedly, restarting...");
    } catch (err) {
      console.error("Server failed to start:", err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

startServer();
