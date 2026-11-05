/** The name of every per-sandbox Kubernetes/Docker resource (pod, PVC,
 * Service, container, volume). Derived from the id, never stored. */
export function resourceName(sandboxId: string): string {
  return `sandbox-${sandboxId}`;
}
