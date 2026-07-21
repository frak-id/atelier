/** Interactive attach: pipe local stdin<->the sandbox process over the WS
 * bridge. Ctrl-] detaches (like telnet). */

import WebSocket from "ws";
import { wsAttach } from "./client.ts";
import type { CliConfig } from "./config.ts";

export async function attach(
  cfg: CliConfig,
  id: string,
  name: string,
): Promise<void> {
  const { url, headers } = wsAttach(cfg, id, name);
  // The `ws` package accepts a `headers` option for the handshake, which the
  // browser/undici `WebSocket` cannot set — that's why the CLI depends on it.
  const ws = new WebSocket(url, { headers });
  ws.binaryType = "arraybuffer";
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const restore = () => {
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
    stdin.pause();
  };

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      // Ctrl-] (0x1d) detaches locally without killing the remote process.
      if (chunk.length === 1 && chunk[0] === 0x1d) {
        ws.close();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    };
    ws.on("open", () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    });
    ws.on("message", (data: Buffer | ArrayBuffer, isBinary: boolean) => {
      if (isBinary) {
        process.stdout.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
      } else {
        process.stdout.write(data.toString());
      }
    });
    ws.on("close", () => {
      stdin.off("data", onData);
      restore();
      resolve();
    });
    ws.on("error", () => {
      stdin.off("data", onData);
      restore();
      reject(new Error(`attach failed: ${url}`));
    });
  });
}
