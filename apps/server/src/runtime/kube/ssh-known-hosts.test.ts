/**
 * `known_hosts` formatting for the sshpiper `Pipe`'s pinned `known_hosts_data`
 * (see the module doc in ssh-known-hosts.ts for the exact host-pattern
 * contract sshpiper/knownhosts expects).
 */
import { describe, expect, test } from "bun:test";
import { buildKnownHostsData, knownHostsPattern } from "./ssh-known-hosts.ts";

describe("knownHostsPattern", () => {
  test("port 22 (default) is a bare hostname", () => {
    expect(knownHostsPattern("sandbox-abc.ns.svc", 22)).toBe(
      "sandbox-abc.ns.svc",
    );
  });

  test("a non-default port uses the bracketed [host]:port form", () => {
    expect(knownHostsPattern("sandbox-abc.ns.svc", 2222)).toBe(
      "[sandbox-abc.ns.svc]:2222",
    );
  });
});

describe("buildKnownHostsData", () => {
  test("one line per pinned key, comments stripped, base64-encoded", () => {
    const data = buildKnownHostsData("sandbox-abc.ns.svc", 22, [
      "ssh-ed25519 AAAAC3ed key-comment",
      "ssh-rsa AAAAB3rsa another-comment",
    ]);
    expect(data).toBeDefined();
    const decoded = Buffer.from(data as string, "base64").toString();
    expect(decoded.split("\n")).toEqual([
      "sandbox-abc.ns.svc ssh-ed25519 AAAAC3ed",
      "sandbox-abc.ns.svc ssh-rsa AAAAB3rsa",
    ]);
  });

  test("a non-default port pins the bracketed host pattern", () => {
    const data = buildKnownHostsData("sandbox-abc.ns.svc", 2222, [
      "ssh-ed25519 AAAAC3ed",
    ]);
    const decoded = Buffer.from(data as string, "base64").toString();
    expect(decoded).toBe("[sandbox-abc.ns.svc]:2222 ssh-ed25519 AAAAC3ed");
  });

  test("blank/whitespace-only lines are skipped", () => {
    const data = buildKnownHostsData("host", 22, [
      "  ",
      "ssh-ed25519 AAAAC3ed",
      "",
    ]);
    const decoded = Buffer.from(data as string, "base64").toString();
    expect(decoded).toBe("host ssh-ed25519 AAAAC3ed");
  });

  test("no usable key lines returns undefined (caller falls back unpinned)", () => {
    expect(buildKnownHostsData("host", 22, [])).toBeUndefined();
    expect(buildKnownHostsData("host", 22, ["   ", ""])).toBeUndefined();
  });
});
