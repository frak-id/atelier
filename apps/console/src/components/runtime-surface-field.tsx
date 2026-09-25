import {
  isSecretRef,
  type MaybeSecretString,
  type PortEntry,
  type ProcessEntry,
  type Readiness,
  type RestartPolicy,
  type RuntimeSurface,
} from "@atelier/spec";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Globe,
  Lock,
  Network,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  addPort,
  addService,
  type Exposure,
  exposureOf,
  type PortRow,
  portIssues,
  processIssues,
  processWarnings,
  removePort,
  removeService,
  type ServiceDefaults,
  type ServiceRow,
  setPortExposure,
  setServicePort,
  surfaceRows,
  surfaceValid,
  updatePort,
  updateProcess,
} from "@/lib/runtime-surface";
import { cn } from "@/lib/utils";

const EXPOSURE_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "login", label: "Login required" },
  { value: "open", label: "Public" },
] as const satisfies readonly { value: Exposure; label: string }[];

const EXPOSURE_HINT: Record<Exposure, string> = {
  private: "No URL: only reachable from inside the sandbox.",
  login: "Gets a URL; visitors sign in first.",
  open: "Gets a URL anyone with the link can open.",
};

/**
 * The processes + ports editor (a `RuntimeSurface`) shared by the toolbox,
 * prebuild and Launchpad starter editors, as *service cards*: a process and
 * the port of the same name it serves edit together (command, directory,
 * user, when it starts, its port and who can open it), with readiness,
 * dependencies, restart and env under "Advanced". Ports no process claims by
 * name (e.g. the browser toolbox's `browser`, gated by `kasmvnc`'s readiness)
 * get their own card.
 *
 * Edits are applied in place to the two arrays (`lib/runtime-surface.ts`),
 * so keys the form doesn't show (`primary`, `pty`, `stdio`) survive; the
 * host's JSON mode edits everything. `onValidityChange` lets the host block
 * Save on a blocking issue, and reports valid again on unmount (the field is
 * gone, so is its error).
 */
export function RuntimeSurfaceField({
  value,
  onChange,
  onValidityChange,
  hint,
  defaults,
  cwdSuggestions = [],
  emptyText = "Nothing runs yet.",
}: {
  value: RuntimeSurface;
  onChange: (surface: RuntimeSurface) => void;
  onValidityChange?: (valid: boolean) => void;
  /** What this surface is for, under the list. */
  hint?: React.ReactNode;
  /** Pre-filled on a new service (e.g. a prebuild's dev servers run as
   * `dev`, start on first open, serve a port). */
  defaults?: ServiceDefaults;
  /** Offered for a process's working directory (e.g. the clone paths). */
  cwdSuggestions?: string[];
  emptyText?: string;
}) {
  const id = useId();
  const valid = surfaceValid(value);
  const rows = surfaceRows(value);
  const processNames = (value.processes ?? []).map((p) => p.name);

  // Runs on mount too, so a remount (visual↔JSON toggle) re-establishes it.
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);
  useEffect(() => () => onValidityChange?.(true), [onValidityChange]);

  return (
    <div className="space-y-3">
      <datalist id={`${id}-cwd`}>
        {cwdSuggestions.map((cwd) => (
          <option key={cwd} value={cwd} />
        ))}
      </datalist>
      <datalist id={`${id}-user`}>
        <option value="dev" />
        <option value="root" />
      </datalist>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        rows.map((row) =>
          row.kind === "service" ? (
            <ServiceCard
              // Keyed by position: the name follows typing, and a changing
              // key would remount the card (losing focus).
              key={`process-${row.processIndex}`}
              row={row}
              surface={value}
              onChange={onChange}
              processNames={processNames}
              listIds={{ cwd: `${id}-cwd`, user: `${id}-user` }}
              cwdPlaceholder={cwdSuggestions[0] ?? "home directory"}
            />
          ) : (
            <PortCard
              key={`port-${row.portIndex}`}
              row={row}
              surface={value}
              onChange={onChange}
            />
          ),
        )
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange(
              addService(value, {
                ...defaults,
                port: defaults?.port ?? 3000,
              }),
            )
          }
        >
          <Plus />
          Add a server
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange(
              addService(value, {
                ...defaults,
                name: "worker",
                port: undefined,
              }),
            )
          }
        >
          <Plus />
          Background process
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(addPort(value))}
        >
          <Plus />
          Port only
        </Button>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ── service card ────────────────────────────────────────────────────────────

function ServiceCard({
  row,
  surface,
  onChange,
  processNames,
  listIds,
  cwdPlaceholder,
}: {
  row: ServiceRow;
  surface: RuntimeSurface;
  onChange: (surface: RuntimeSurface) => void;
  processNames: string[];
  listIds: { cwd: string; user: string };
  cwdPlaceholder: string;
}) {
  const id = useId();
  const { process, port, processIndex, portIndex } = row;
  const issues = processIssues(surface, processIndex);
  const portProblems =
    portIndex !== undefined ? portIssues(surface, portIndex) : {};
  const warnings = processWarnings(surface, processIndex);
  const patch = (next: Partial<ProcessEntry>) =>
    onChange(updateProcess(surface, processIndex, next));
  /** Flags the form doesn't edit, shown so they aren't a surprise. */
  const flags = [
    process.primary ? "primary" : null,
    process.pty ? "pty" : null,
    process.stdio && process.stdio !== "none"
      ? `stdio: ${process.stdio}`
      : null,
  ].filter((f): f is string => f !== null);

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Server className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            aria-label="Name"
            aria-invalid={issues.name ? true : undefined}
            value={process.name}
            onChange={(e) => patch({ name: e.target.value.trim() })}
            placeholder="web"
            className="h-8 font-mono"
          />
          <FieldError message={issues.name} />
        </div>
        {flags.map((flag) => (
          <Badge
            key={flag}
            variant="neutral"
            title="Set in the JSON editor"
            className="mt-1.5 font-mono font-normal"
          >
            {flag}
          </Badge>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onChange(removeService(surface, processIndex))}
          aria-label={`Remove ${process.name || "process"}`}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${id}-command`}>Command</Label>
        <textarea
          id={`${id}-command`}
          aria-invalid={issues.command ? true : undefined}
          value={process.command}
          onChange={(e) => patch({ command: e.target.value })}
          spellCheck={false}
          rows={1}
          placeholder="bun run dev"
          className="field-sizing-content max-h-40 min-h-9 w-full resize-none rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs"
        />
        <FieldError message={issues.command} />
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <div className="space-y-1">
          <Label htmlFor={`${id}-cwd`}>Directory</Label>
          <Input
            id={`${id}-cwd`}
            list={listIds.cwd}
            value={process.cwd ?? ""}
            onChange={(e) => patch({ cwd: e.target.value || undefined })}
            placeholder={cwdPlaceholder}
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-user`}>Run as</Label>
          <Input
            id={`${id}-user`}
            list={listIds.user}
            value={process.user ?? ""}
            onChange={(e) =>
              patch({ user: e.target.value.trim() || undefined })
            }
            placeholder="default"
            className="font-mono text-xs"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Starts</span>
        <SegmentedControl
          options={[
            { value: "boot", label: "With the sandbox" },
            { value: "lazy", label: "When first opened" },
          ]}
          value={process.lazy ? "lazy" : "boot"}
          onChange={(start) =>
            patch({ lazy: start === "lazy" ? true : undefined })
          }
        />
      </div>

      <ServedPort
        name={process.name}
        port={port}
        issues={portProblems}
        onToggle={(on) => {
          const probed =
            process.readiness && "port" in process.readiness
              ? process.readiness.port
              : undefined;
          onChange(
            setServicePort(
              surface,
              processIndex,
              on ? (probed ?? 3000) : undefined,
            ),
          );
        }}
        onPortChange={(n) => onChange(setServicePort(surface, processIndex, n))}
        onExposureChange={(exposure) => {
          if (portIndex === undefined) return;
          onChange(setPortExposure(surface, portIndex, exposure));
        }}
      />

      <AdvancedSection
        process={process}
        servedPort={port?.port}
        otherProcesses={processNames.filter((n) => n !== process.name)}
        issues={issues}
        onChange={patch}
      />

      {warnings.map((warning) => (
        <p
          key={warning}
          className="flex items-start gap-1.5 text-xs text-warning"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {warning}
        </p>
      ))}
    </div>
  );
}

function ServedPort({
  name,
  port,
  issues,
  onToggle,
  onPortChange,
  onExposureChange,
}: {
  name: string;
  port?: PortEntry;
  issues: { port?: string };
  onToggle: (on: boolean) => void;
  onPortChange: (port: number) => void;
  onExposureChange: (exposure: Exposure) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2.5">
      <label
        htmlFor={`${id}-serves`}
        className="flex items-center gap-2 text-sm font-medium"
      >
        <Checkbox
          id={`${id}-serves`}
          checked={port !== undefined}
          onChange={(e) => onToggle(e.target.checked)}
        />
        Serves a port
      </label>
      {port ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <PortNumberInput
              value={port.port}
              invalid={Boolean(issues.port)}
              onChange={onPortChange}
            />
            <SegmentedControl
              options={EXPOSURE_OPTIONS}
              value={exposureOf(port)}
              onChange={onExposureChange}
            />
          </div>
          <FieldError message={issues.port} />
          <ExposureHint name={name} port={port} />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          A watcher or worker: runs without a URL.
        </p>
      )}
    </div>
  );
}

// ── port card ───────────────────────────────────────────────────────────────

function PortCard({
  row,
  surface,
  onChange,
}: {
  row: PortRow;
  surface: RuntimeSurface;
  onChange: (surface: RuntimeSurface) => void;
}) {
  const { port, portIndex, gatedBy } = row;
  const issues = portIssues(surface, portIndex);
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Network className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            aria-label="Port name"
            aria-invalid={issues.name ? true : undefined}
            value={port.name}
            onChange={(e) =>
              onChange(
                updatePort(surface, portIndex, { name: e.target.value.trim() }),
              )
            }
            placeholder="browser"
            className="h-8 font-mono"
          />
          <FieldError message={issues.name} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onChange(removePort(surface, portIndex))}
          aria-label={`Remove port ${port.name}`}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PortNumberInput
          value={port.port}
          invalid={Boolean(issues.port)}
          onChange={(n) =>
            onChange(updatePort(surface, portIndex, { port: n }))
          }
        />
        <SegmentedControl
          options={EXPOSURE_OPTIONS}
          value={exposureOf(port)}
          onChange={(exposure) =>
            onChange(setPortExposure(surface, portIndex, exposure))
          }
        />
      </div>
      <FieldError message={issues.port} />
      <ExposureHint name={port.name} port={port} />
      <p className="text-xs text-muted-foreground">
        {gatedBy.length > 0 ? (
          <>
            Opening it waits for{" "}
            {gatedBy.map((name, i) => (
              <span key={name}>
                {i > 0 ? ", " : ""}
                <code>{name}</code>
              </span>
            ))}{" "}
            (its readiness probes port {port.port}).
          </>
        ) : (
          <>
            No process here gates it: something else must listen on {port.port}{" "}
            (a process from another toolbox, or a base-image service).
          </>
        )}
      </p>
    </div>
  );
}

// ── advanced ────────────────────────────────────────────────────────────────

type ReadinessKind = "port" | "http" | "cmd" | "none";

function readinessKind(readiness?: Readiness): ReadinessKind {
  if (!readiness) return "none";
  if ("port" in readiness) return "port";
  if ("http" in readiness) return "http";
  return "cmd";
}

const RESTART_OPTIONS: { value: RestartPolicy | ""; label: string }[] = [
  { value: "", label: "Runtime default" },
  { value: "never", label: "Never" },
  { value: "on-failure", label: "On failure" },
  { value: "always", label: "Always" },
];

function AdvancedSection({
  process,
  servedPort,
  otherProcesses,
  issues,
  onChange,
}: {
  process: ProcessEntry;
  servedPort?: number;
  otherProcesses: string[];
  issues: { env?: string; readiness?: string };
  onChange: (patch: Partial<ProcessEntry>) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const kind = readinessKind(process.readiness);
  // A probe that follows the served port is fixed from there: don't pop
  // the section open while that port is being retyped.
  const followsPort =
    process.readiness &&
    "port" in process.readiness &&
    process.readiness.port === servedPort;
  const shown =
    open || Boolean(issues.env || (issues.readiness && !followsPort));
  const envCount = Object.keys(process.env ?? {}).length;
  const after = process.after ?? [];

  const summary = [
    kind === "port" && process.readiness && "port" in process.readiness
      ? `ready on :${process.readiness.port}`
      : kind === "http"
        ? "ready on HTTP"
        : kind === "cmd"
          ? "ready on command"
          : null,
    after.length > 0 ? `after ${after.join(", ")}` : null,
    process.restart ? `restart ${process.restart}` : null,
    envCount > 0 ? `${envCount} env` : null,
  ].filter((s): s is string => s !== null);

  function setKind(next: ReadinessKind) {
    if (next === kind) return;
    const readiness: Readiness | undefined =
      next === "port"
        ? { port: servedPort ?? 3000 }
        : next === "http"
          ? { http: servedPort !== undefined ? "/" : "http://127.0.0.1/" }
          : next === "cmd"
            ? { cmd: "" }
            : undefined;
    onChange({ readiness });
  }

  function toggleAfter(name: string) {
    const next = after.includes(name)
      ? after.filter((n) => n !== name)
      : [...after, name];
    onChange({ after: next.length > 0 ? next : undefined });
  }

  // Declared elsewhere (another toolbox/prebuild): kept, removable.
  const foreignAfter = after.filter((n) => !otherProcesses.includes(n));

  return (
    <div>
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {shown ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        <span className="font-medium">Advanced</span>
        {summary.length > 0 ? (
          <span className="truncate font-mono">· {summary.join(" · ")}</span>
        ) : null}
      </button>
      {shown ? (
        <div className="mt-3 space-y-4 border-l-2 pl-3">
          <div className="space-y-1.5">
            <Label className="block">Ready when</Label>
            <SegmentedControl
              options={[
                { value: "port", label: "Port listens" },
                { value: "http", label: "HTTP answers" },
                { value: "cmd", label: "Command succeeds" },
                { value: "none", label: "Started" },
              ]}
              value={kind}
              onChange={setKind}
            />
            {process.readiness && "port" in process.readiness ? (
              <PortNumberInput
                value={process.readiness.port}
                invalid={Boolean(issues.readiness)}
                onChange={(port) => onChange({ readiness: { port } })}
              />
            ) : process.readiness && "http" in process.readiness ? (
              <Input
                aria-label="Readiness URL"
                value={process.readiness.http}
                onChange={(e) =>
                  onChange({ readiness: { http: e.target.value } })
                }
                placeholder="/health or http://127.0.0.1:3000/health"
                className="font-mono text-xs"
              />
            ) : process.readiness && "cmd" in process.readiness ? (
              <Input
                aria-label="Readiness command"
                value={process.readiness.cmd}
                onChange={(e) =>
                  onChange({ readiness: { cmd: e.target.value } })
                }
                placeholder="test -S /tmp/app.sock"
                className="font-mono text-xs"
              />
            ) : null}
            <FieldError message={issues.readiness} />
            <p className="text-xs text-muted-foreground">
              Opening a URL, and processes that wait for this one, hold until
              it's ready. A path is checked on the port this serves.
            </p>
          </div>

          {otherProcesses.length > 0 || foreignAfter.length > 0 ? (
            <div className="space-y-1.5">
              <Label className="block">Waits for</Label>
              <div className="flex flex-wrap gap-1.5">
                {[...otherProcesses, ...foreignAfter].map((name) => {
                  const on = after.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleAfter(name)}
                      title={
                        otherProcesses.includes(name)
                          ? undefined
                          : "Declared in another toolbox or prebuild"
                      }
                      className={cn(
                        "rounded-md border px-2 py-0.5 font-mono text-xs transition-colors",
                        on
                          ? "border-primary bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                        !otherProcesses.includes(name) && "border-dashed",
                      )}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-restart`} className="block">
              Restart
            </Label>
            <div className="w-44">
              <NativeSelect
                id={`${id}-restart`}
                value={process.restart ?? ""}
                onChange={(e) =>
                  onChange({
                    restart: (e.target.value || undefined) as
                      | RestartPolicy
                      | undefined,
                  })
                }
                className="h-8 text-xs"
              >
                {RESTART_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="block">Environment</Label>
            <EnvEditor
              env={process.env}
              onChange={(env) => onChange({ env })}
            />
            <FieldError message={issues.env} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── env ─────────────────────────────────────────────────────────────────────

/** Key/value rows over a `Record`, order kept. A value is text or a
 * `{ "$secret": name }` reference, resolved by the control layer. */
function EnvEditor({
  env,
  onChange,
}: {
  env?: Record<string, MaybeSecretString>;
  onChange: (env: Record<string, MaybeSecretString> | undefined) => void;
}) {
  const entries = Object.entries(env ?? {});

  function commit(next: [string, MaybeSecretString][]) {
    onChange(next.length > 0 ? Object.fromEntries(next) : undefined);
  }

  function replace(index: number, entry: [string, MaybeSecretString]) {
    // A key renamed onto another one would silently merge: keep the row.
    if (entries.some(([k], i) => i !== index && k === entry[0])) return;
    commit(entries.map((e, i) => (i === index ? entry : e)));
  }

  return (
    <div className="space-y-1.5">
      {entries.map(([key, value], index) => {
        const secret = isSecretRef(value);
        const text = isSecretRef(value) ? value.$secret : value;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: keys are typed in place
          <div key={index} className="flex items-center gap-1.5">
            <Input
              aria-label="Variable name"
              value={key}
              onChange={(e) => replace(index, [e.target.value.trim(), value])}
              placeholder="NAME"
              className="h-8 w-40 font-mono text-xs"
            />
            <NativeSelect
              aria-label="Value kind"
              value={secret ? "secret" : "text"}
              onChange={(e) =>
                replace(index, [
                  key,
                  e.target.value === "secret" ? { $secret: "" } : "",
                ])
              }
              className="h-8 w-24 text-xs"
            >
              <option value="text">Value</option>
              <option value="secret">Secret</option>
            </NativeSelect>
            <Input
              aria-label={secret ? "Secret name" : "Value"}
              value={text}
              onChange={(e) =>
                replace(index, [
                  key,
                  secret ? { $secret: e.target.value.trim() } : e.target.value,
                ])
              }
              placeholder={secret ? "secret name" : "value"}
              className="h-8 flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => commit(entries.filter((_, i) => i !== index))}
              aria-label={`Remove ${key || "variable"}`}
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={entries.some(([k]) => k === "")}
        onClick={() => commit([...entries, ["", ""]])}
      >
        <Plus />
        Add variable
      </Button>
    </div>
  );
}

// ── bits ────────────────────────────────────────────────────────────────────

/** A port number field over a `number` model: blank reads as `0` (flagged
 * by the validation), so a half-typed value never needs local state. */
function PortNumberInput({
  value,
  invalid,
  onChange,
}: {
  value: number;
  invalid?: boolean;
  onChange: (port: number) => void;
}) {
  return (
    <Input
      aria-label="Port"
      aria-invalid={invalid ? true : undefined}
      type="number"
      inputMode="numeric"
      min={1}
      max={65535}
      value={value > 0 ? value : ""}
      onChange={(e) => {
        const n = Number.parseInt(e.target.value, 10);
        onChange(Number.isNaN(n) ? 0 : n);
      }}
      placeholder="3000"
      className={cn(
        "h-8 w-24 font-mono text-xs",
        invalid && "border-danger focus-visible:ring-danger",
      )}
    />
  );
}

function ExposureHint({ name, port }: { name: string; port: PortEntry }) {
  const exposure = exposureOf(port);
  const Icon =
    exposure === "private" ? Lock : exposure === "login" ? ShieldCheck : Globe;
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <p className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0" />
        {EXPOSURE_HINT[exposure]}
      </p>
      {exposure !== "private" ? (
        <p className="pl-5">
          <code className="text-foreground/80">
            {name || "name"}-‹sandbox›.‹domain›
          </code>
        </p>
      ) : null}
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-danger">{message}</p> : null;
}
