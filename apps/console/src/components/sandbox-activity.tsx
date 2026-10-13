/**
 * The sandbox page's Activity card (idle auto-pause): whether it will be
 * paused when nobody uses it and when, a keep-awake control, what was seen
 * last per signal, the last hour of agent measurements, and network traffic
 * by process (stats only: the pause decision never looks at processes).
 */
import {
  type ActivityMinute,
  type ActivitySignal,
  INTERFACE_NETWORK_SENSOR,
  KEEP_AWAKE_FOREVER,
  type SandboxActivity,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { sandboxActivityQuery, useKeepAwake } from "@/api/queries/sandboxes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";
import {
  BLOCKER_LABELS,
  formatBytes,
  formatDuration,
  idleStatePresentation,
  keepAwakeChoices,
  keepAwakeUntil,
  msUntil,
  SIGNAL_LABELS,
} from "@/lib/idle";
import { cn } from "@/lib/utils";

const ALL_SIGNALS: ActivitySignal[] = [
  "ssh",
  "console",
  "agent",
  "api",
  "networkInbound",
  "networkOutbound",
  "files",
  "cpu",
  "lifecycle",
];

export function SandboxActivitySection({ sandboxId }: { sandboxId: string }) {
  const { data, isPending, isError, error } = useQuery(
    sandboxActivityQuery(sandboxId),
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Activity</CardTitle>
          <CardDescription>
            {data ? <Summary activity={data} /> : "Idle auto-pause"}
          </CardDescription>
        </div>
        {data ? (
          <Badge variant={idleStatePresentation(data.state).variant}>
            {idleStatePresentation(data.state).label}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        {isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : (
          <>
            {data.state !== "off" && data.state !== "not-running" ? (
              <KeepAwake activity={data} />
            ) : null}
            <MinuteBars activity={data} />
            <Signals activity={data} />
            <ProcessTraffic activity={data} />
            <Sensors activity={data} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** One plain sentence: what happens if nobody uses the sandbox. */
function Summary({ activity: a }: { activity: SandboxActivity }) {
  const last = a.lastActiveAt
    ? `Last used ${formatRelativeTime(a.lastActiveAt)}`
    : "";
  switch (a.state) {
    case "off":
      return <>Idle auto-pause is off on this server.</>;
    case "not-running":
      return a.idlePausedAt ? (
        <>
          Paused {formatRelativeTime(a.idlePausedAt)} after {a.idleMinutes} min
          without use.
        </>
      ) : (
        <>Only a running sandbox has an idle clock.</>
      );
    case "active":
      return (
        <>
          {last}. {a.mode === "observe" ? "Would pause" : "Pauses"} in{" "}
          {a.pausesAt ? formatDuration(msUntil(a.pausesAt)) : "?"} if nobody
          uses it.
          {a.mode === "observe" ? " (Observe mode: nothing is paused.)" : ""}
        </>
      );
    case "due":
      return (
        <>
          {last}.{" "}
          {a.mode === "enforce"
            ? "Pausing within a minute."
            : "Idle past the limit: would be paused (observe mode)."}
        </>
      );
    case "blocked":
      return (
        <>
          {last}. Not paused while{" "}
          {a.blockers
            .map((b) =>
              b === "keep-awake" && a.keepAwakeUntil
                ? a.keepAwakeUntil === KEEP_AWAKE_FOREVER
                  ? "kept awake until turned off"
                  : `kept awake for ${formatDuration(msUntil(a.keepAwakeUntil))}`
                : BLOCKER_LABELS[b],
            )
            .join(", ")}
          .
        </>
      );
  }
}

function KeepAwake({ activity: a }: { activity: SandboxActivity }) {
  const keepAwake = useKeepAwake();
  const choices = keepAwakeChoices(a.keepAwakeLimits);
  const [choice, setChoice] = useState(
    choices.find((c) => c.value === "8")?.value ?? choices[0]?.value ?? "1",
  );

  if (a.keepAwakeUntil) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Sun className="size-4 text-warning" />
        <span>
          Kept awake{" "}
          {a.keepAwakeUntil === KEEP_AWAKE_FOREVER
            ? "until turned off"
            : `until ${new Date(a.keepAwakeUntil).toLocaleString()}`}
        </span>
        <Button
          variant="outline"
          size="sm"
          loading={keepAwake.isPending}
          onClick={() => keepAwake.mutate({ id: a.sandboxId, until: null })}
        >
          <Moon />
          Let it sleep
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Keep awake for</span>
      <NativeSelect
        className="h-8 w-40"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        aria-label="Keep awake for"
      >
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </NativeSelect>
      <Button
        variant="outline"
        size="sm"
        loading={keepAwake.isPending}
        onClick={() =>
          keepAwake.mutate({ id: a.sandboxId, until: keepAwakeUntil(choice) })
        }
      >
        <Sun />
        Keep awake
      </Button>
    </div>
  );
}

/** The last hour, one bar per minute (oldest left). Highlighted: a minute
 * whose traffic reached the threshold; a dot: file writes. */
function MinuteBars({ activity: a }: { activity: SandboxActivity }) {
  if (!a.agent.reporting) return null;
  const now = Date.now();
  const slots: (ActivityMinute | undefined)[] = Array.from({ length: 60 });
  for (const m of a.minutes) {
    const age = Math.floor((now - new Date(m.start).getTime()) / 60_000);
    if (age >= 0 && age < 60) slots[59 - age] = m;
  }
  const total = (m: ActivityMinute) => m.inboundBytes + m.outboundBytes;
  const max = Math.max(1, ...a.minutes.map(total));
  const threshold = a.thresholds.networkMinBytesPerMinute;
  // Interface counters: no direction, the sum counts (as on the server).
  const undirected = a.agent.network === INTERFACE_NETWORK_SENSOR;

  return (
    <div className="space-y-1">
      <div className="flex h-12 items-end gap-px">
        {slots.map((m, i) => {
          const bytes = m ? total(m) : 0;
          const counts =
            !!m &&
            (undirected
              ? total(m) >= threshold
              : m.inboundBytes >= threshold || m.outboundBytes >= threshold);
          const height = bytes
            ? Math.max(8, (Math.log1p(bytes) / Math.log1p(max)) * 100)
            : 0;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 60 slots
              key={i}
              className="relative flex h-full flex-1 flex-col justify-end"
              title={m ? minuteTitle(m, undirected) : undefined}
            >
              {m && m.fileWrites > 0 ? (
                <span className="absolute top-0 left-1/2 size-1 -translate-x-1/2 rounded-full bg-info" />
              ) : null}
              <div
                className={cn(
                  "w-full rounded-sm",
                  counts ? "bg-primary" : "bg-muted-foreground/30",
                )}
                style={{ height: `${height}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>1 h ago</span>
        <span>
          Network per minute · counts from {formatBytes(threshold)} · dots: file
          writes
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

function minuteTitle(m: ActivityMinute, undirected: boolean): string {
  const time = new Date(m.start).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return [
    time,
    `${undirected ? "received" : "in"} ${formatBytes(m.inboundBytes)}`,
    `${undirected ? "sent" : "out"} ${formatBytes(m.outboundBytes)}`,
    m.fileWrites ? `${m.fileWrites} file writes` : "",
    m.cpuMs ? `CPU ${(m.cpuMs / 1000).toFixed(1)} s` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function Signals({ activity: a }: { activity: SandboxActivity }) {
  return (
    <div className="space-y-1">
      <SignalGrid activity={a} />
      <p className="text-xs text-muted-foreground">
        An agent used through its own terminal or web UI counts through its
        traffic and its file edits.
      </p>
    </div>
  );
}

function SignalGrid({ activity: a }: { activity: SandboxActivity }) {
  return (
    <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {ALL_SIGNALS.map((signal) => {
        const counted = a.counted.includes(signal);
        const at = a.signals[signal];
        return (
          <div
            key={signal}
            className={cn(
              "flex justify-between gap-2",
              !counted && "text-muted-foreground/60",
            )}
          >
            <span>{SIGNAL_LABELS[signal]}</span>
            <span className="text-muted-foreground">
              {counted ? (at ? formatRelativeTime(at) : "—") : "not counted"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ProcessTraffic({ activity: a }: { activity: SandboxActivity }) {
  if (a.agent.network === INTERFACE_NETWORK_SENSOR) {
    return (
      <p className="text-xs text-muted-foreground">
        Network is measured per interface here: this sandbox's guest kernel
        can't report traffic per connection, so there is no breakdown by
        process, and any traffic counts whatever its direction.
      </p>
    );
  }
  if (a.processes.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        Network by process, last hour
      </p>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="text-left font-normal">Process</th>
            <th className="text-right font-normal">Inbound</th>
            <th className="text-right font-normal">Outbound</th>
          </tr>
        </thead>
        <tbody>
          {a.processes.map((p) => (
            <tr key={p.name}>
              <td className="py-0.5">
                <span className="font-mono text-xs">{p.name}</span>
                {p.supervised ? (
                  <Badge variant="outline" className="ml-2 px-1.5 py-0">
                    process
                  </Badge>
                ) : null}
              </td>
              <td className="text-right tabular-nums">
                {formatBytes(p.inboundBytes)}
              </td>
              <td className="text-right tabular-nums">
                {formatBytes(p.outboundBytes)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sensors({ activity: a }: { activity: SandboxActivity }) {
  if (!a.agent.reporting) {
    return (
      <p className="text-xs text-muted-foreground">
        {a.agent.polledAt
          ? "This sandbox's agent doesn't report network or file activity " +
            "(its image predates idle auto-pause, or it is unreachable). " +
            "Rebuild the image to measure them."
          : "Waiting for the first activity poll (once a minute)."}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Sensors: network {a.agent.network} · files {a.agent.files} · CPU{" "}
      {a.agent.cpu}
      {a.agent.polledAt
        ? ` · polled ${formatRelativeTime(a.agent.polledAt)}`
        : ""}
    </p>
  );
}
