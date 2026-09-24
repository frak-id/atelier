import { mergeSpecs } from "@atelier/compose";
import { type RuntimeSurface, runtimeSurfaceOf } from "@atelier/spec";

/**
 * The runtime surface a spawn gets, layered by name with `mergeSpecs` (a
 * later layer wins on a clash, in place):
 *
 * 1. the prebuild it boots from: its projects' dev servers;
 * 2. its toolboxes: the tools applied to it (pi-web, code-server…) — a
 *    toolbox beats a prebuild, so a project naming its dev server `pi-web`
 *    can't replace the tool;
 * 3. the spec's own entries: the caller's explicit word.
 *
 * `shadowed` names the prebuild entries a toolbox replaced, for a warning.
 */
export function spawnSurface(layers: {
  prebuild?: RuntimeSurface;
  toolboxes: RuntimeSurface;
  own: RuntimeSurface;
}): RuntimeSurface & { shadowed: string[] } {
  const prebuild = runtimeSurfaceOf(layers.prebuild ?? {});
  const toolboxes = runtimeSurfaceOf(layers.toolboxes);
  const merged = mergeSpecs(prebuild, toolboxes, runtimeSurfaceOf(layers.own));
  const names = (list?: { name: string }[]) =>
    new Set((list ?? []).map((e) => e.name));
  const toolProcesses = names(toolboxes.processes);
  const toolPorts = names(toolboxes.ports);
  const shadowed = [
    ...[...names(prebuild.processes)].filter((n) => toolProcesses.has(n)),
    ...[...names(prebuild.ports)]
      .filter((n) => toolPorts.has(n))
      .map((n) => `port ${n}`),
  ];
  return { ...runtimeSurfaceOf(merged), shadowed };
}
