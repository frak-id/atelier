import { LAUNCHPAD_ICONS, type LaunchpadService } from "@atelier/spec";
import { AppWindow, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { LaunchpadIconView } from "@/lib/launchpad";

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "tool"
  );
}

/** A service id unique among `taken`, derived from its label. */
function uniqueId(label: string, taken: Set<string>): string {
  const base = slugify(label);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** The tools a workspace surfaces: an ordered list of port or link rows. */
export function StarterServices({
  services,
  onChange,
  portSuggestions,
}: {
  services: LaunchpadService[];
  onChange: (services: LaunchpadService[]) => void;
  portSuggestions: string[];
}) {
  const listId = useId();

  function add() {
    const taken = new Set(services.map((s) => s.id));
    const port = portSuggestions.find(
      (name) =>
        !services.some((s) => "port" in s.target && s.target.port === name),
    );
    const label = port ? port.charAt(0).toUpperCase() + port.slice(1) : "Tool";
    onChange([
      ...services,
      { id: uniqueId(label, taken), label, target: { port: port ?? "" } },
    ]);
  }

  function replace(index: number, next: LaunchpadService) {
    onChange(services.map((s, i) => (i === index ? next : s)));
  }

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= services.length) return;
    const next = services.slice();
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <datalist id={listId}>
        {portSuggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {services.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No tools yet. Without any, the workspace shows every public port of
          the sandbox as-is.
        </p>
      ) : (
        services.map((service, index) => (
          <ServiceRow
            // Keyed by position, not id: the id follows the label as it's
            // typed, and a changing key would remount the row (losing focus).
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            service={service}
            portListId={listId}
            takenIds={
              new Set(services.filter((_, i) => i !== index).map((s) => s.id))
            }
            onChange={(next) => replace(index, next)}
            onRemove={() => onChange(services.filter((_, i) => i !== index))}
            onMoveUp={index > 0 ? () => move(index, -1) : undefined}
            onMoveDown={
              index < services.length - 1 ? () => move(index, 1) : undefined
            }
          />
        ))
      )}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus />
        Add a tool
      </Button>
    </div>
  );
}

function ServiceRow({
  service,
  portListId,
  takenIds,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  service: LaunchpadService;
  portListId: string;
  takenIds: Set<string>;
  onChange: (service: LaunchpadService) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const isPort = "port" in service.target;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-md bg-muted">
          <LaunchpadIconView
            icon={service.icon}
            fallback={AppWindow}
            className="size-4"
          />
        </span>
        <Input
          aria-label="Label"
          value={service.label}
          maxLength={60}
          onChange={(e) => {
            const label = e.target.value;
            // The id follows the label: it only has to be unique within
            // the starter (workspaces keep their own snapshot).
            onChange({ ...service, label, id: uniqueId(label, takenIds) });
          }}
          placeholder="Assistant"
          className="flex-1"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!onMoveUp}
          onClick={onMoveUp}
          aria-label="Move up"
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!onMoveDown}
          onClick={onMoveDown}
          aria-label="Move down"
        >
          <ArrowDown />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label="Remove tool"
        >
          <Trash2 />
        </Button>
      </div>
      <Input
        aria-label="Description"
        value={service.description ?? ""}
        maxLength={200}
        onChange={(e) =>
          onChange({ ...service, description: e.target.value || undefined })
        }
        placeholder="Short hint, e.g. “Ask for changes in plain English”"
      />
      <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
        <SegmentedControl
          options={[
            { value: "port", label: "Workspace port" },
            { value: "url", label: "Link" },
          ]}
          value={isPort ? "port" : "url"}
          onChange={(kind) =>
            onChange({
              ...service,
              target: kind === "port" ? { port: "" } : { url: "https://" },
            })
          }
        />
        {"port" in service.target ? (
          <div className="grid grid-cols-2 gap-2">
            <Input
              aria-label="Port name"
              list={portListId}
              value={service.target.port}
              onChange={(e) =>
                onChange({
                  ...service,
                  target: {
                    ...service.target,
                    port: e.target.value.trim(),
                  } as { port: string; path?: string },
                })
              }
              placeholder="port name, e.g. pi"
              className="font-mono"
            />
            <Input
              aria-label="Path"
              value={service.target.path ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const path = raw ? (raw.startsWith("/") ? raw : `/${raw}`) : "";
                const port = (service.target as { port: string }).port;
                onChange({
                  ...service,
                  target: path ? { port, path } : { port },
                });
              }}
              placeholder="/path (optional)"
              className="font-mono"
            />
          </div>
        ) : (
          <Input
            aria-label="Link"
            value={service.target.url}
            onChange={(e) =>
              onChange({ ...service, target: { url: e.target.value.trim() } })
            }
            placeholder="https://staging.example.com/{sandboxId}"
            className="font-mono"
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Opens</span>
          <SegmentedControl
            options={[
              { value: "embed", label: "In the page" },
              { value: "external", label: "In a new tab" },
            ]}
            value={service.open ?? "embed"}
            onChange={(open) => onChange({ ...service, open })}
          />
        </div>
        <NativeSelect
          aria-label="Icon"
          value={service.icon ?? ""}
          onChange={(e) =>
            onChange({ ...service, icon: e.target.value || undefined })
          }
          className="h-8 w-36 text-xs"
        >
          <option value="">Default icon</option>
          {LAUNCHPAD_ICONS.map((icon) => (
            <option key={icon} value={icon}>
              {icon}
            </option>
          ))}
        </NativeSelect>
      </div>
      {service.open !== "external" ? (
        <p className="text-xs text-muted-foreground">
          If the tool refuses to be embedded (it shows a blank page), choose “In
          a new tab”.
        </p>
      ) : null}
    </div>
  );
}
