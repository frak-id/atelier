/** Capture a live sandbox's state into a reusable artifact — a fresh toolset or
 * a new version of a toolbox you own. */
import pc from "picocolors";
import { type AtelierApi, unwrap, waitForJob } from "../../client.ts";
import * as ui from "../../ui.ts";
import { BACK } from "./common.ts";
import { gatherToolboxes, toolboxHint } from "./toolboxes.ts";

const TOOLSET_NAME_RE =
  /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;

const splitWords = (raw: string): string[] =>
  raw.trim() ? raw.trim().split(/\s+/) : [];

/** Capture the current sandbox state into a reusable artifact. Two backed
 * shapes: a standalone toolset (fresh: name + paths you choose) or a new
 * version of a toolbox you own (its own declared paths). */
export async function captureFlow(api: AtelierApi, id: string): Promise<void> {
  const kind = await ui.select<"toolset" | "toolbox" | "back">({
    message: "Capture this sandbox as…",
    options: [
      {
        value: "toolset",
        label: "Toolset (fresh)",
        hint: "portable bundle of home paths (dotfiles/configs); referenced by ref in a spec",
      },
      {
        value: "toolbox",
        label: "Toolbox version",
        hint: "new version of a toolbox you own — managed, named, versioned, auto-injectable",
      },
      { value: "back", label: pc.dim("Back") },
    ],
  });
  if (kind === "toolset") await captureToolset(api, id);
  else if (kind === "toolbox") await captureToolboxVersion(api, id);
}

/** Fresh toolset capture: name + paths are mandatory; exclude globs and
 * secret-scan overrides are optional. */
async function captureToolset(api: AtelierApi, id: string): Promise<void> {
  const name = await ui.text({
    message: "Toolset name",
    placeholder: "my-dotfiles",
    validate: (v) =>
      !v.trim()
        ? "required"
        : TOOLSET_NAME_RE.test(v.trim())
          ? undefined
          : "lowercase alnum + . _ - , slash-separated (e.g. team/pi)",
  });
  if (!name.trim()) return;
  const paths = splitWords(
    await ui.text({
      message: "Paths to capture (space-separated, home-relative)",
      placeholder: ".config/nvim .local/share/foo .zshrc",
      validate: (v) => (v.trim() ? undefined : "at least one path required"),
    }),
  );
  if (paths.length === 0) return;
  const exclude = splitWords(
    await ui.text({
      message: "Exclude globs (optional, space-separated)",
      placeholder: "**/*.log **/cache/**",
      defaultValue: "",
    }),
  );
  const overrides = splitWords(
    await ui.text({
      message: "Override paths to allow past the secret scan (optional)",
      placeholder: ".config/gh/hosts.yml",
      defaultValue: "",
    }),
  );
  const s = ui.spinner();
  s.start("Capturing toolset…");
  try {
    const job = unwrap(
      await api.v1.sandboxes({ id }).toolsets.capture.post({
        name: name.trim(),
        paths,
        exclude,
        overrides,
      }),
    );
    const ref = await waitForJob<{ ref: string }>(api, job);
    s.stop(`Captured ${ref.ref}`);
  } catch (err) {
    s.stop("Capture failed");
    ui.note(err instanceof Error ? err.message : String(err));
  }
}

/** Toolbox-version capture: pick a toolbox you own, describe it; the server
 * captures the toolbox's OWN declared paths (no path entry here). */
async function captureToolboxVersion(
  api: AtelierApi,
  id: string,
): Promise<void> {
  const all = await gatherToolboxes(api).catch(() => []);
  const capturable = all.filter((t) => t.paths.length > 0);
  if (capturable.length === 0) {
    ui.note(
      "No toolbox with capturable paths. Create one first (`atelier toolbox create`).",
    );
    return;
  }
  const tbId = await ui.select<string | typeof BACK>({
    message: "Capture a version of which toolbox?",
    options: [
      ...capturable.map((t) => ({
        value: t.id,
        label: t.slug,
        hint: `${t.paths.length} path(s) · ${toolboxHint(t)}`,
      })),
      { value: BACK, label: pc.dim("Back") },
    ],
  });
  if (tbId === BACK) return;
  const description = await ui.text({
    message: "Version description",
    placeholder: "add nvim + zsh config",
    validate: (v) => (v.trim() ? undefined : "required"),
  });
  if (!description.trim()) return;
  const s = ui.spinner();
  s.start("Capturing toolbox version…");
  try {
    const job = unwrap(
      await api.api.toolboxes({ id: tbId }).versions.capture.post({
        sandboxId: id,
        description: description.trim(),
      }),
    );
    const v = await waitForJob<{ label: string; ref: string }>(api, job);
    s.stop(`Captured v${v.label}`);
  } catch (err) {
    s.stop("Capture failed");
    ui.note(err instanceof Error ? err.message : String(err));
  }
}
