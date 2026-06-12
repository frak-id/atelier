import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import type { KubeClient } from "../infrastructure/kubernetes/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import {
  createSandboxOpencodeClient,
  type SandboxOpencodeClient,
} from "../shared/lib/opencode-client.ts";
import { waitForOpencodeHealthy } from "./kernel/boot-waiter.ts";

const log = createChildLogger("opencode-warmup");

const OPENCODE_WARMUP_PORT = 4200;
const OPENCODE_WARMUP_BOOTSTRAP_TIMEOUT_MS = 120_000;

export interface WarmupDeps {
  agentClient: AgentClient;
  kubeClient: KubeClient;
}

/**
 * Bake the per-directory OpenCode caches into the prebuild snapshot.
 *
 * `opencode serve` is just an HTTP control plane: it does not migrate the DB,
 * install plugins, download ripgrep, or initialize the project until a request
 * arrives carrying a `directory=` parameter (which triggers
 * `InstanceMiddleware` -> `InstanceBootstrap.run` in OpenCode). Without that
 * trigger, none of the heavy startup work lands on the PVC and every
 * subsequent sandbox pays the full ~30s cold-start cost on its first request.
 *
 * To populate the snapshot, we boot opencode against the first repo dir as cwd
 * and explicitly drive `session.list` / `app.agents` / `find.text` for every
 * workspace repo, forcing the bootstrap to complete (DB migrations, ripgrep
 * download, npm install of plugins, project .opencode/ init) before we kill
 * the process and snapshot the PVC.
 */
export async function warmupOpencode(
  deps: WarmupDeps,
  sandboxId: string,
  bootstrapDirs: string[],
): Promise<void> {
  if (bootstrapDirs.length === 0) {
    log.warn({ sandboxId }, "No bootstrap dirs for OpenCode warmup, skipping");
    return;
  }

  const agent = deps.agentClient;
  const namespace = config.kubernetes.namespace;
  const podName = `sandbox-${sandboxId}`;
  const cwd = bootstrapDirs[0] ?? VM.HOME;

  log.info({ sandboxId, bootstrapDirs }, "Warming up OpenCode server");

  // Start opencode in background inside the pod
  const startResult = await agent.exec(
    sandboxId,
    `nohup setsid opencode serve --hostname 0.0.0.0 --port ${OPENCODE_WARMUP_PORT} </dev/null >/tmp/opencode-warmup.log 2>&1 &`,
    { timeout: 10_000, user: "dev", workdir: cwd },
  );
  if (startResult.exitCode !== 0) {
    log.warn(
      { sandboxId, stderr: startResult.stderr },
      "Failed to start OpenCode for warmup, continuing",
    );
    return;
  }

  // Get pod IP to connect to OpenCode endpoints
  let podIp: string | undefined;
  try {
    const pod = await deps.kubeClient.get<{
      status?: { podIP?: string };
    }>(`/api/v1/namespaces/${namespace}/pods/${podName}`);
    podIp = pod.status?.podIP;
  } catch {
    log.warn({ sandboxId }, "Failed to get pod IP for warmup health check");
  }

  if (!podIp) {
    await killWarmupOpencode(deps, sandboxId);
    return;
  }

  // Readiness probe must fail fast — a wedged /health shouldn't burn the warmup
  // budget — so the shared poll's fast per-request abort applies. Don't throw
  // on timeout: warmup is best-effort and the snapshot can still proceed.
  const healthy = await waitForOpencodeHealthy(podIp, "prebuild", {
    port: OPENCODE_WARMUP_PORT,
    throwOnTimeout: false,
  });
  if (!healthy) {
    log.warn(
      { sandboxId },
      "OpenCode did not become healthy within timeout, continuing",
    );
    await killWarmupOpencode(deps, sandboxId);
    return;
  }

  // The bootstrap calls below legitimately run for tens of seconds (DB
  // migration, plugin npm install, ripgrep download), so this client gets a
  // much longer per-request budget than the fast readiness probe above.
  const bootstrapClient = createSandboxOpencodeClient(podIp, "prebuild", {
    timeoutMs: OPENCODE_WARMUP_BOOTSTRAP_TIMEOUT_MS,
    port: OPENCODE_WARMUP_PORT,
  });

  // Trigger InstanceBootstrap for each workspace dir. This is what installs
  // plugins, downloads ripgrep, applies migrations, and primes the project
  // .opencode/ directory — the work we want baked into the snapshot.
  for (const directory of bootstrapDirs) {
    const ok = await bootstrapWarmupDirectory(
      bootstrapClient,
      sandboxId,
      directory,
    );
    if (!ok) {
      log.warn(
        { sandboxId, directory },
        "Directory bootstrap did not complete, snapshot may be cold",
      );
    }
  }

  // Even though `app.agents` and `find.text` returned, OpenCode forks the
  // actual `Npm.add` reify (Arborist install of plugin packages) into a
  // background fiber. Killing the warmup pod too quickly aborts that fiber
  // and the install never lands on disk. Poll the cache until at least one
  // plugin package.json materializes (or we time out).
  await waitForPluginsInstalled(deps, sandboxId);

  // Flush page cache to disk before we kill so the snapshot is consistent.
  await agent.exec(sandboxId, "sync", { timeout: 10_000 }).catch(() => {});

  await killWarmupOpencode(deps, sandboxId);
  log.info(
    { sandboxId, bootstrapped: bootstrapDirs.length },
    "OpenCode warmup completed",
  );
}

/**
 * Poll until external OpenCode plugins have finished installing to
 * `~/.cache/opencode/packages/<spec>/node_modules/<name>/`.
 *
 * `app.agents` returns once the plugin registry resolves in-memory, but the
 * actual npm install (`Npm.add` -> Arborist reify) runs in a forked fiber
 * and may still be writing files when the request completes. We wait for the
 * filesystem to settle before snapshotting; otherwise the cache slot is
 * empty and every sandbox spawned from the snapshot pays the full ~16s
 * `import()` + reify cost on its first request.
 */
async function waitForPluginsInstalled(
  deps: WarmupDeps,
  sandboxId: string,
): Promise<void> {
  const POLL_INTERVAL_MS = 2_000;
  const SETTLE_MS = 3_000;
  const TIMEOUT_MS = 90_000;
  // Bail early if no plugin install ever appears — the workspace probably
  // has no external plugins configured, so there's nothing to wait for.
  const NO_PLUGIN_BAIL_MS = 12_000;
  const PROBE = `find /home/dev/.cache/opencode/packages -mindepth 4 -name 'package.json' -type f 2>/dev/null | wc -l`;

  const startTime = Date.now();
  let lastCount = -1;
  let stableSince = 0;
  let everSeenInstall = false;

  while (Date.now() - startTime < TIMEOUT_MS) {
    const result = await deps.agentClient
      .exec(sandboxId, PROBE, { timeout: 10_000 })
      .catch(() => ({ exitCode: 1, stdout: "0", stderr: "" }));

    const count = Number.parseInt(result.stdout.trim(), 10) || 0;
    if (count > 0) everSeenInstall = true;

    if (count > 0 && count === lastCount) {
      // Count has been stable across polls — install finished.
      if (Date.now() - stableSince >= SETTLE_MS) {
        log.info(
          { sandboxId, pluginCount: count, waitedMs: Date.now() - startTime },
          "Plugin install settled",
        );
        return;
      }
    } else {
      if (count !== lastCount) {
        log.debug(
          { sandboxId, pluginCount: count },
          "Plugin install progressing",
        );
      }
      lastCount = count;
      stableSince = Date.now();
    }

    // Short-circuit: if nothing has appeared after the bail window, the
    // workspace likely has no external plugins. Don't waste 90s.
    if (!everSeenInstall && Date.now() - startTime >= NO_PLUGIN_BAIL_MS) {
      log.info(
        { sandboxId, waitedMs: Date.now() - startTime },
        "No external plugins detected, skipping plugin install wait",
      );
      return;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  log.warn(
    { sandboxId, lastPluginCount: lastCount, timeoutMs: TIMEOUT_MS },
    "Timed out waiting for plugin install \u2014 snapshot may not include plugins",
  );
}

async function bootstrapWarmupDirectory(
  client: SandboxOpencodeClient,
  sandboxId: string,
  directory: string,
): Promise<boolean> {
  log.info({ sandboxId, directory }, "Triggering OpenCode instance bootstrap");
  const startTime = Date.now();

  try {
    // session.list goes through InstanceMiddleware -> InstanceStore.load,
    // which awaits InstanceBootstrap.run. That kicks off DB migrations and
    // calls Plugin.init(). It does NOT block on the actual npm install of
    // plugins or the ripgrep binary download — those are forked async by
    // their respective service init() functions.
    const sessionRes = await client.session.list({ directory, limit: 1 });
    if (sessionRes.error) {
      log.warn(
        { sandboxId, directory, error: String(sessionRes.error) },
        "OpenCode session.list errored during bootstrap",
      );
      return false;
    }

    // Force the plugin install to complete: enumerating agents requires
    // every plugin to be loaded (plugins register agents at load time), so
    // this call cannot return until ~/.config/opencode/node_modules/ is
    // populated.
    const agentsRes = await client.app.agents({ directory });
    if (agentsRes.error) {
      log.warn(
        { sandboxId, directory, error: String(agentsRes.error) },
        "OpenCode app.agents errored during bootstrap",
      );
    }

    // Force the ripgrep download: any text search invokes the rg binary,
    // which the File service downloads on first use into
    // ~/.local/share/opencode/bin/. The pattern is a no-op string we don't
    // expect to match.
    const findRes = await client.find.text({
      directory,
      pattern: "__atelier_warmup__",
    });
    if (findRes.error) {
      log.warn(
        { sandboxId, directory, error: String(findRes.error) },
        "OpenCode find.text errored during ripgrep warmup",
      );
    }

    log.info(
      {
        sandboxId,
        directory,
        totalDurationMs: Date.now() - startTime,
        agentsCount: agentsRes.data?.length ?? 0,
      },
      "OpenCode instance bootstrapped (plugins + ripgrep forced)",
    );
    return true;
  } catch (error) {
    log.warn(
      { sandboxId, directory, error: String(error) },
      "OpenCode instance bootstrap failed",
    );
    return false;
  }
}

async function killWarmupOpencode(
  deps: WarmupDeps,
  sandboxId: string,
): Promise<void> {
  await deps.agentClient
    .exec(sandboxId, "pkill -f 'opencode serve'", { timeout: 5_000 })
    .catch(() => {});
}
