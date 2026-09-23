/**
 * `known_hosts` formatting for the sshpiper `Pipe`'s `to.known_hosts_data`
 * (SSH host-key pinning, docs/proposals/portable-runtime-backends.md §5).
 * sshpiper >= 1.6 hands the raw `known_hosts` bytes straight to
 * `golang.org/x/crypto/ssh/knownhosts`, which matches lines against the exact
 * host string it dials — the sshpiper `to.host` field, i.e. `host:port`
 * (cmd/sshpiperd/internal/plugin/grpc.go + plugin/kubernetes/skel.go in
 * github.com/tg123/sshpiper v1.6.1). `knownhosts.Normalize` writes that as a
 * bare hostname for the default SSH port (22) and as `[host]:port` for any
 * other port — mirrored here so a pinned line always matches what sshpiper
 * looks up. Every sandbox target uses port 22 today (see `buildSshPipe`), so
 * the bracketed form is untested against a live sshpiper but kept for
 * correctness / a future non-default port.
 */
import { Buffer } from "node:buffer";

const DEFAULT_SSH_PORT = 22;

/** The `knownhosts.Normalize`-equivalent host pattern for a `host:port`. */
export function knownHostsPattern(host: string, port: number): string {
  return port === DEFAULT_SSH_PORT ? host : `[${host}]:${port}`;
}

/**
 * Build base64 `known_hosts` content pinning `publicKeyLines` (OpenSSH
 * `<type> <base64> [comment]` lines, e.g. from the agent's
 * `GET /ssh/host-keys`) to `host:port`. One `known_hosts` line per input key
 * (a host can have multiple algorithms); any trailing comment on the input
 * line is dropped, matching plain `known_hosts` line shape. Empty/blank
 * input lines are skipped. Returns `undefined` when no usable key lines are
 * given, so a caller can fall back to the unpinned strategy.
 */
export function buildKnownHostsData(
  host: string,
  port: number,
  publicKeyLines: string[],
): string | undefined {
  const pattern = knownHostsPattern(host, port);
  const lines = publicKeyLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [type, key] = line.split(/\s+/);
      return type && key ? `${pattern} ${type} ${key}` : undefined;
    })
    .filter((line): line is string => line !== undefined);
  if (lines.length === 0) return undefined;
  return Buffer.from(lines.join("\n")).toString("base64");
}
