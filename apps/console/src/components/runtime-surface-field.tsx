import type { PortEntry, ProcessEntry, RuntimeSurface } from "@atelier/spec";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/** Parse one JSON-array field: `undefined` when blank, else the array or
 * an error message. The server validates each entry against its schema. */
function parseArray(
  text: string,
  what: string,
): { value?: unknown[]; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const value = JSON.parse(trimmed);
    if (!Array.isArray(value)) return { error: `${what} must be a JSON array` };
    return { value };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : `${what} is not valid JSON`,
    };
  }
}

/**
 * The processes + ports editor (a `RuntimeSurface`) shared by the toolbox,
 * prebuild and starter editors: one JSON array each, the toolbox scheme (`name`, `command`, `cwd`, `lazy`,
 * `readiness`… / `name`, `port`, `public`, `auth`). A port is gated by the
 * process of the same name (or whose `readiness.port` probes it); a `lazy`
 * process starts on first open, from the sandbox view or the Launchpad.
 *
 * Collapsed until opened (open when there's something in it, and while
 * it doesn't parse, so the error shows). The text is local state so a
 * half-typed array survives renders; `onValidityChange` lets the host block
 * Save while it doesn't parse, and reports valid again on unmount (the
 * field is gone, so is its error).
 */
export function RuntimeSurfaceField({
  value,
  onChange,
  onValidityChange,
  hint,
  placeholders,
}: {
  value: RuntimeSurface;
  onChange: (surface: RuntimeSurface) => void;
  onValidityChange?: (valid: boolean) => void;
  /** What this surface is for, under the processes field. */
  hint: React.ReactNode;
  placeholders: { processes: string; ports: string };
}) {
  const id = useId();
  const [open, setOpen] = useState(
    () => (value.processes?.length ?? 0) > 0 || (value.ports?.length ?? 0) > 0,
  );
  const [processesText, setProcessesText] = useState(() =>
    value.processes ? JSON.stringify(value.processes, null, 2) : "",
  );
  const [portsText, setPortsText] = useState(() =>
    value.ports ? JSON.stringify(value.ports, null, 2) : "",
  );
  const processes = parseArray(processesText, "Processes");
  const ports = parseArray(portsText, "Ports");
  const valid = !processes.error && !ports.error;
  const shown = open || !valid;

  // Runs on mount too, so a remount (visual↔JSON toggle) re-establishes it.
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);
  useEffect(() => () => onValidityChange?.(true), [onValidityChange]);

  function commit(nextProcesses: string, nextPorts: string) {
    setProcessesText(nextProcesses);
    setPortsText(nextPorts);
    const p = parseArray(nextProcesses, "Processes");
    const q = parseArray(nextPorts, "Ports");
    // Keep the last valid value while a field is being typed.
    if (p.error || q.error) return;
    onChange({
      processes: p.value as ProcessEntry[] | undefined,
      ports: q.value as PortEntry[] | undefined,
    });
  }

  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={shown}
        onClick={() => setOpen((o) => !o)}
      >
        {shown ? <ChevronDown /> : <ChevronRight />}
        Processes &amp; ports
      </Button>
      {shown ? (
        <div className="mt-3 space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-processes`}>
              Processes (JSON array, optional)
            </Label>
            <textarea
              id={`${id}-processes`}
              value={processesText}
              onChange={(e) => commit(e.target.value, portsText)}
              spellCheck={false}
              placeholder={placeholders.processes}
              className="min-h-24 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
            />
            {processes.error ? (
              <p className="text-sm text-destructive">{processes.error}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-ports`}>Ports (JSON array, optional)</Label>
            <textarea
              id={`${id}-ports`}
              value={portsText}
              onChange={(e) => commit(processesText, e.target.value)}
              spellCheck={false}
              placeholder={placeholders.ports}
              className="min-h-16 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
            />
            {ports.error ? (
              <p className="text-sm text-destructive">{ports.error}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
