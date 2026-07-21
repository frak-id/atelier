/**
 * The in-server ssh2 proxy — the drop-in replacement for the external sshpiper
 * Deployment (docs/proposals/portable-runtime-backends.md §5). It terminates
 * and re-originates: it presents its own persistent host key, authenticates the
 * dev by public key (username = sandboxId, verified against the control SSH
 * keys), then opens an upstream ssh2 client connection to `pod:22` as the
 * upstream user (with the shared ssh-pipe key) and forwards every channel and
 * request the dev's tools exercise:
 *
 *   - `session`: pty (+ env, window-change, signal) → shell/exec — interactive
 *     shells and `git`/scp-style exec;
 *   - the `sftp` subsystem — forwarded as a raw byte pipe (we deliberately do
 *     NOT attach a `sftp` listener so ssh2 routes it through `subsystem`);
 *   - `direct-tcpip` — port forwarding, which is what VS Code / Cursor / editor
 *     Remote-SSH rides on.
 *
 * Upstream host keys are ignored: pods are ephemeral inside the cluster trust
 * boundary (the same stance the sshpiper `Pipe` took with `ignore_hostkey`).
 * SSH sessions live in this process, so a server redeploy drops live
 * connections — acceptable for a dev tool, stated honestly in the proposal.
 */
import type { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import ssh2, {
  type AuthContext,
  type ClientChannel,
  type Connection,
  type ParsedKey,
  type PseudoTtyInfo,
  type ServerChannel,
  type Session,
} from "ssh2";
import { createChildLogger } from "../shared/lib/logger.ts";

const { Server, Client, utils } = ssh2;
const log = createChildLogger("ssh-gateway");

/** Where a sandbox's `sshd` is reachable from the server. */
export interface UpstreamTarget {
  host: string;
  port: number;
}

export interface InServerSshGatewayDeps {
  /** TCP port the proxy binds. */
  listenPort: number;
  /** Bind address (default `0.0.0.0`). */
  bindHost?: string;
  /** The proxy's own persistent host key (OpenSSH private key). */
  hostKey: string;
  /** Upstream user to log into the pod as (e.g. `dev`). */
  upstreamUser: string;
  /** The shared ssh-pipe key (OpenSSH private key) the pod trusts. */
  upstreamPrivateKey: string;
  /**
   * The dev public keys currently authorized (OpenSSH lines). Read fresh on
   * every authentication so a newly-added key takes effect without a restart —
   * mirrors sshpiper reading the live `Pipe`'s `authorized_keys_data`.
   */
  authorizedKeys: () => string[];
  /**
   * Resolve the upstream `pod:22` for a sandbox id (the SSH username), or
   * `null` when the sandbox is unknown / not running.
   */
  resolveUpstream: (
    sandboxId: string,
  ) => Promise<UpstreamTarget | null> | UpstreamTarget | null;
}

export interface InServerSshGateway {
  /** The actually-bound port (equals `listenPort` unless it was 0). */
  port: number;
  close: () => Promise<void>;
}

/** Constant-time compare of two public-key blobs. */
function keyEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse the configured authorized keys, dropping any that don't parse. */
function parseAuthorizedKeys(lines: string[]): ParsedKey[] {
  const keys: ParsedKey[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = utils.parseKey(trimmed);
    if (parsed instanceof Error) {
      log.warn({ err: parsed.message }, "skipping unparseable authorized key");
      continue;
    }
    // parseKey may return an array for multi-key inputs; normalize.
    for (const k of Array.isArray(parsed) ? parsed : [parsed]) keys.push(k);
  }
  return keys;
}

/**
 * Authenticate a publickey attempt against the authorized set. Returns the
 * matched key on success (so the caller can `accept`), or `null` to reject.
 * When a signature is present (the real attempt, not the pubkey-acceptable
 * probe), it must verify against the offered key.
 */
function authenticate(
  ctx: Extract<AuthContext, { method: "publickey" }>,
  authorized: ParsedKey[],
): boolean {
  const match = authorized.find(
    (k) => k.type === ctx.key.algo && keyEquals(k.getPublicSSH(), ctx.key.data),
  );
  if (!match) return false;
  // The initial "is this key acceptable?" probe carries no signature — accept
  // so the client proceeds to send the signed attempt.
  if (!ctx.signature || !ctx.blob) return true;
  return match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true;
}

/** Bidirectional raw pipe for byte-faithful channels (sftp, direct-tcpip). */
function pipeRaw(a: Duplex, b: Duplex): void {
  a.pipe(b);
  b.pipe(a);
  const end = () => {
    a.end();
    b.end();
  };
  a.once("error", end);
  b.once("error", end);
  a.once("close", () => b.end());
  b.once("close", () => a.end());
}

/**
 * Forward an interactive/exec channel: stdout+stderr both ways, plus the exit
 * status (so `git`/exec see the real code) before closing.
 */
function pipeChannel(client: ServerChannel, upstream: ClientChannel): void {
  client.pipe(upstream);
  upstream.pipe(client);
  // Only the upstream produces stderr (pod → dev); stdin has no stderr channel.
  upstream.stderr.pipe(client.stderr);
  upstream.on("exit", (code: number | null, signal?: string) => {
    try {
      if (signal) client.exit(signal);
      else client.exit(code ?? 0);
    } catch {
      // channel may already be torn down
    }
  });
  upstream.once("close", () => client.close());
  client.once("close", () => upstream.close());
  const drop = () => {
    upstream.close();
    client.close();
  };
  client.once("error", drop);
  upstream.once("error", drop);
}

/** Translate a client pty request into upstream shell/exec pty options. */
function ptyOptions(info: PseudoTtyInfo) {
  return {
    rows: info.rows,
    cols: info.cols,
    height: info.height,
    width: info.width,
    // `term` is present on the wire even though @types/ssh2 omits it.
    term: (info as PseudoTtyInfo & { term?: string }).term ?? "xterm-256color",
    modes: info.modes,
  };
}

/** Wire one authenticated client session to a ready upstream connection. */
function handleSession(accept: () => Session, upstream: ssh2.Client): void {
  const session = accept();
  let pty: PseudoTtyInfo | null = null;
  const env: Record<string, string> = {};
  let active: ClientChannel | null = null;

  session.on("pty", (a, _r, info) => {
    pty = info;
    a?.();
  });
  session.on("env", (a, _r, info) => {
    env[info.key] = info.val;
    a?.();
  });
  session.on("window-change", (a, _r, info) => {
    active?.setWindow(info.rows, info.cols, info.height, info.width);
    a?.();
  });
  session.on("signal", (a, _r, info) => {
    active?.signal(info.name.replace(/^SIG/, ""));
    a?.();
  });

  session.once("shell", (a) => {
    const client = a();
    upstream.shell(pty ? ptyOptions(pty) : false, { env }, (err, stream) => {
      if (err) {
        log.warn({ err: err.message }, "upstream shell failed");
        client.close();
        return;
      }
      active = stream;
      pipeChannel(client, stream);
    });
  });

  session.once("exec", (a, _r, info) => {
    const client = a();
    upstream.exec(
      info.command,
      { pty: pty ? ptyOptions(pty) : undefined, env },
      (err, stream) => {
        if (err) {
          log.warn({ err: err.message }, "upstream exec failed");
          client.close();
          return;
        }
        active = stream;
        pipeChannel(client, stream);
      },
    );
  });

  // No `sftp` listener is attached on purpose: ssh2 then routes the sftp
  // subsystem through `subsystem`, giving us a raw channel to byte-forward.
  session.once("subsystem", (a, r, info) => {
    const client = a();
    upstream.subsys(info.name, (err, stream) => {
      if (err) {
        log.warn(
          { err: err.message, name: info.name },
          "upstream subsys failed",
        );
        return r?.();
      }
      pipeRaw(client, stream);
    });
  });
}

/** Forward a direct-tcpip (port forward) channel — Remote-SSH's transport. */
function handleTcpip(
  accept: () => ServerChannel,
  reject: () => void,
  upstream: ssh2.Client,
  info: { srcIP: string; srcPort: number; destIP: string; destPort: number },
): void {
  upstream.forwardOut(
    info.srcIP,
    info.srcPort,
    info.destIP,
    info.destPort,
    (err, stream) => {
      if (err) {
        log.warn(
          { err: err.message, dest: info.destPort },
          "forwardOut failed",
        );
        return reject();
      }
      pipeRaw(accept(), stream);
    },
  );
}

/** Start the in-server ssh2 proxy and resolve once it is listening. */
export function startInServerSshGateway(
  deps: InServerSshGatewayDeps,
): Promise<InServerSshGateway> {
  const server = new Server(
    { hostKeys: [deps.hostKey] },
    (client: Connection) => {
      let sandboxId = "";

      client.on("authentication", (ctx) => {
        if (ctx.method !== "publickey") {
          return ctx.reject(["publickey"], true);
        }
        const authorized = parseAuthorizedKeys(deps.authorizedKeys());
        if (!authenticate(ctx, authorized)) return ctx.reject();
        sandboxId = ctx.username;
        ctx.accept();
      });

      client.on("ready", () => {
        void connectUpstream(client, sandboxId, deps);
      });

      client.on("error", (err) => {
        // Client-side resets are routine (idle timeouts, Ctrl-C); log at debug.
        log.debug({ err: err.message, sandboxId }, "client connection error");
      });
    },
  );

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(deps.listenPort, deps.bindHost ?? "0.0.0.0", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port =
        typeof addr === "object" && addr ? addr.port : deps.listenPort;
      log.info({ port }, "in-server ssh2 gateway listening");
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/** Dial the sandbox's pod and bridge the client's channels to it. */
async function connectUpstream(
  client: Connection,
  sandboxId: string,
  deps: InServerSshGatewayDeps,
): Promise<void> {
  let target: UpstreamTarget | null;
  try {
    target = await deps.resolveUpstream(sandboxId);
  } catch (err) {
    log.warn({ err, sandboxId }, "upstream resolution failed");
    target = null;
  }
  if (!target) {
    log.warn({ sandboxId }, "no upstream for sandbox; closing");
    client.end();
    return;
  }

  const upstream = new Client();
  const pending: Array<() => void> = [];
  let ready = false;

  // Buffer channel requests that arrive before the upstream is ready.
  const whenReady = (fn: () => void) => {
    if (ready) fn();
    else pending.push(fn);
  };

  client.on("session", (accept) =>
    whenReady(() => handleSession(accept, upstream)),
  );
  client.on("tcpip", (accept, rejectFn, info) =>
    whenReady(() => handleTcpip(accept, rejectFn, upstream, info)),
  );

  upstream.on("ready", () => {
    ready = true;
    for (const fn of pending.splice(0)) fn();
  });
  upstream.on("error", (err) => {
    log.warn({ err: err.message, sandboxId }, "upstream connection error");
    client.end();
  });
  upstream.on("close", () => client.end());
  client.on("close", () => upstream.end());

  upstream.connect({
    host: target.host,
    port: target.port,
    username: deps.upstreamUser,
    privateKey: deps.upstreamPrivateKey,
    // Ephemeral pods churn host keys; we are inside the cluster trust boundary.
    hostVerifier: () => true,
    keepaliveInterval: 15_000,
    readyTimeout: 20_000,
  });
}
