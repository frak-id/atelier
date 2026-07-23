/** Toolbox discovery + selection for the cockpit's spawn/capture flows. */
import type { ToolboxConfig } from "@atelier/spec";
import { type AtelierApi, unwrap } from "../../client.ts";
import * as ui from "../../ui.ts";

const toolboxSelector = (t: ToolboxConfig): string =>
  `tb/${t.ownerType}/${t.ownerId}/${t.slug}`;

/** Surface a toolbox provides, mirroring the console's spawn badges: whether
 * it's always-on, its harness, the processes it runs, and its description. */
export function toolboxHint(t: ToolboxConfig): string {
  const parts: string[] = [];
  if (t.autoInject) parts.push("always on");
  if (t.harness) parts.push(`harness: ${t.harness}`);
  if (t.processes && t.processes.length > 0) {
    parts.push(`runs: ${t.processes.map((p) => p.name).join(",")}`);
  }
  if (t.description) parts.push(t.description);
  return parts.join(" · ");
}

/** Every toolbox visible to the caller (personal + each org they belong to). */
export async function gatherToolboxes(
  api: AtelierApi,
): Promise<ToolboxConfig[]> {
  const me = unwrap(await api.api.me.get());
  const owners: (string | undefined)[] = [
    undefined,
    ...me.organizations.map((o) => `org:${o.id}`),
  ];
  const lists = await Promise.all(
    owners.map((o) =>
      api.api.toolboxes.get({ query: o ? { owner: o } : {} }).then(unwrap),
    ),
  );
  const seen = new Set<string>();
  return lists.flat().filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/** Offer the caller's toolboxes as a multi-select. Auto-inject toolboxes are
 * pre-checked and always included (the server injects them regardless). */
export async function pickToolboxes(api: AtelierApi): Promise<string[]> {
  const toolboxes = await gatherToolboxes(api).catch(() => []);
  if (toolboxes.length === 0) return [];
  const forced = toolboxes.filter((t) => t.autoInject).map(toolboxSelector);
  const picks = await ui.multiselect<string>({
    message: "Toolsets to layer on (auto ones are always on)",
    required: false,
    initialValues: forced,
    options: toolboxes.map((t) => ({
      value: toolboxSelector(t),
      label: t.slug,
      hint: toolboxHint(t),
    })),
  });
  return Array.from(new Set([...forced, ...picks]));
}
