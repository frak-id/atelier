/** The cockpit's Account & SSH panel: identity + SSH readiness, plus one-shot
 * SSH key setup / regeneration. */
import pc from "picocolors";
import { type AtelierApi, unwrap } from "../../client.ts";
import { ok } from "../../output.ts";
import {
  ATELIER_KEY_PATH,
  defaultKeyLabel,
  generateAtelierKey,
  type LocalKey,
  readLocalKey,
  removeAtelierKey,
  resolveSshRegistration,
} from "../../ssh-keys.ts";
import * as ui from "../../ui.ts";

/** The Account & SSH panel: show identity + SSH readiness, then offer to set up
 * or regenerate the atelier SSH key. Kept out of the per-sandbox menu so global
 * concerns live in one place. */
export async function accountMenu(api: AtelierApi): Promise<void> {
  const s = ui.spinner();
  s.start("Loading account…");
  let me: Awaited<ReturnType<typeof loadMe>>;
  let registered: LocalKey | undefined;
  let localCount = 0;
  try {
    me = await loadMe(api);
    const ssh = await resolveSshRegistration(api);
    localCount = ssh.localKeys.length;
    registered = ssh.registered;
    s.stop("Account");
  } catch (err) {
    s.stop("Failed to load account");
    ui.note(err instanceof Error ? err.message : String(err));
    return;
  }

  const info = [`${pc.bold(me.username)}  ${pc.dim(me.email)}`, `id: ${me.id}`];
  if (me.organizations.length > 0) {
    info.push(`orgs: ${me.organizations.map((o) => o.name).join(", ")}`);
  }
  info.push("");
  info.push(
    `${ok(localCount > 0)} local ssh key ${pc.dim(localCount > 0 ? `${localCount} in ~/.ssh` : "none found")}`,
  );
  info.push(
    `${ok(Boolean(registered))} ssh registered ${pc.dim(registered ? registered.fingerprint : "not set up")}`,
  );
  ui.note(info.join("\n"), "account");

  const action = await ui.select<"setup" | "regen" | "back">({
    message: "Account & SSH",
    options: [
      registered
        ? {
            value: "regen",
            label: "Regenerate SSH key",
            hint: "replace + re-register",
          }
        : {
            value: "setup",
            label: "Set up SSH",
            hint: "generate + register a key",
          },
      { value: "back", label: pc.dim("Back") },
    ],
  });
  if (action === "setup") await setupSsh(api);
  else if (action === "regen") await regenSsh(api);
}

function loadMe(api: AtelierApi) {
  return api.api.me.get().then(unwrap);
}

/** Generate the atelier key (if missing) and register it — the cockpit twin of
 * `atelier ssh-key setup`. */
async function setupSsh(api: AtelierApi): Promise<void> {
  const s = ui.spinner();
  s.start("Generating key…");
  try {
    const local = await generateAtelierKey();
    s.message("Registering…");
    const remote = unwrap(await api.api["ssh-keys"].get());
    if (!remote.some((r) => r.fingerprint === local.fingerprint)) {
      unwrap(
        await api.api["ssh-keys"].post({
          publicKey: local.publicKey,
          name: defaultKeyLabel(),
          type: "generated",
        }),
      );
    }
    s.stop("SSH set up");
    ui.note(
      `${ok(true)} ${local.fingerprint}\nprivate key: ${pc.dim(ATELIER_KEY_PATH)}`,
    );
  } catch (err) {
    s.stop("Setup failed");
    ui.note(err instanceof Error ? err.message : String(err));
  }
}

/** De-register + delete the atelier key, then generate and register a fresh
 * one. Destructive, so it confirms first. */
async function regenSsh(api: AtelierApi): Promise<void> {
  const yes = await ui.confirm({
    message:
      "Regenerate the atelier SSH key? The old key is removed everywhere.",
    initialValue: false,
  });
  if (!yes) return;
  const s = ui.spinner();
  s.start("Regenerating…");
  try {
    const current = readLocalKey(`${ATELIER_KEY_PATH}.pub`);
    if (current) {
      const remote = unwrap(await api.api["ssh-keys"].get());
      const match = remote.find((r) => r.fingerprint === current.fingerprint);
      if (match)
        await api.api["ssh-keys"]({ id: match.id }).delete().then(unwrap);
    }
    removeAtelierKey();
    s.message("Generating new key…");
    const local = await generateAtelierKey();
    s.message("Registering…");
    unwrap(
      await api.api["ssh-keys"].post({
        publicKey: local.publicKey,
        name: defaultKeyLabel(),
        type: "generated",
      }),
    );
    s.stop("SSH key regenerated");
    ui.note(
      `${ok(true)} ${local.fingerprint}\nprivate key: ${pc.dim(ATELIER_KEY_PATH)}`,
    );
  } catch (err) {
    s.stop("Regenerate failed");
    ui.note(err instanceof Error ? err.message : String(err));
  }
}
