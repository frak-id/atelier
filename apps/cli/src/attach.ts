/** Interactive attach: pipe local stdin<->the sandbox process over the WS
 * bridge. Ctrl-] detaches (like telnet). */

import { wsAttach } from "./client.ts";
import type { CliConfig } from "./config.ts";

export async function attach(
  cfg: CliConfig,
  id: string,
  name: string,
): Promise<void> {
  const { url, headers } = wsAttach(cfg, id, name);
  // Bun's WebSocket accepts an options object with `headers` for the
  // handshake (non-DOM extension); declare Bun's actual signature locally.
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const ws = new BunWebSocket(url, { headers });
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
    ws.onopen = () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    };
    ws.onmessage = (event) => {
      const d = event.data;
      if (d instanceof ArrayBuffer) process.stdout.write(Buffer.from(d));
      else process.stdout.write(String(d));
    };
    ws.onclose = () => {
      stdin.off("data", onData);
      restore();
      resolve();
    };
    ws.onerror = () => {
      stdin.off("data", onData);
      restore();
      reject(new Error(`attach failed: ${url}`));
    };
  });
}
