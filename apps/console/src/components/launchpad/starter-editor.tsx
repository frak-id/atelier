import {
  LAUNCHPAD_ICONS,
  type LaunchpadService,
  type PrebuildRecord,
  prebuildRepoBranch,
  repoShortName,
  type StarterInput,
  starterInputProblems,
  type ToolboxConfig,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  Loader2,
  Plus,
  Rocket,
  Trash2,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
  type StarterRecord,
  useCreateStarter,
  useLaunchStarter,
  useUpdateStarter,
} from "@/api/queries/launchpad";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
import { ImageSourcePicker } from "@/components/image-source-picker";
import {
  type SpecEditorApi,
  SpecEditorShell,
} from "@/components/spec-editor-shell";
import { ToolboxPicker } from "@/components/toolbox-picker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAllToolboxes } from "@/hooks/use-all-toolboxes";
import { useDefaultImage } from "@/hooks/use-repo-catalog";
import { LaunchpadIconView } from "@/lib/launchpad";
import { parseStarterInput } from "@/lib/spec";
import { cn } from "@/lib/utils";

function toInput(starter: StarterRecord | undefined, image: string) {
  if (!starter) {
    return {
      title: "",
      description: "",
      icon: "sparkles",
      guide: "",
      published: true,
      recipe: {
        source: { image },
        resources: { vcpus: 2, memoryMb: 4096 },
      },
      services: [],
    } satisfies StarterInput;
  }
  return {
    title: starter.title,
    description: starter.description,
    icon: starter.icon,
    guide: starter.guide,
    published: starter.published,
    recipe: starter.recipe,
    services: starter.services,
  } satisfies StarterInput;
}

/** Visual-form problems the schema alone wouldn't catch, in author words. */
function formProblems(input: StarterInput): string[] {
  const problems = [...starterInputProblems(input)];
  if (!input.title.trim()) problems.push("Give the starter a title.");
  const { source } = input.recipe;
  if ("image" in source && !source.image.trim() && !input.recipe.prebuild) {
    problems.push("Pick what the workspace boots from.");
  }
  for (const service of input.services) {
    if (!service.label.trim()) problems.push("Every tool needs a label.");
    if ("port" in service.target && !service.target.port.trim()) {
      problems.push(`"${service.label || service.id}" needs a port name.`);
    }
    if ("url" in service.target && !/^https?:\/\//.test(service.target.url)) {
      problems.push(
        `"${service.label || service.id}" needs a link starting with https://`,
      );
    }
  }
  return [...new Set(problems)];
}

/**
 * Author a Launchpad starter: what a non-technical user sees (title, icon,
 * description, guide), what boots (prebuild or image + toolboxes +
 * resources) and which tools to surface. The JSON mode exposes the whole
 * recipe (any `CreateSandboxRequest` field: files, env, processes, hooks…).
 */
export function StarterEditor({
  starter,
  owner,
}: {
  starter?: StarterRecord;
  owner: string;
}) {
  const navigate = useNavigate();
  const defaultImage = useDefaultImage();
  const create = useCreateStarter();
  const update = useUpdateStarter();
  const launch = useLaunchStarter();
  const [input, setInput] = useState<StarterInput>(() =>
    toInput(starter, defaultImage),
  );
  const [problems, setProblems] = useState<string[]>([]);
  const pending = create.isPending || update.isPending;

  function handleSave(api: SpecEditorApi<StarterInput>) {
    const value = api.resolve();
    if (!value) return;
    const found = formProblems(value);
    setProblems(found);
    if (found.length > 0) return;
    const back = () => navigate({ to: "/settings/launchpad" });
    if (starter) {
      update.mutate(
        {
          id: starter.id,
          // A full patch; empty icon/guide clear them server-side.
          patch: { ...value, icon: value.icon ?? "", guide: value.guide ?? "" },
        },
        { onSuccess: back },
      );
    } else {
      create.mutate({ owner, input: value }, { onSuccess: back });
    }
  }

  function tryIt() {
    if (!starter) return;
    launch.mutate(
      { starterId: starter.id, request: { title: `Test: ${starter.title}` } },
      {
        onSuccess: (workspace) => {
          if (!workspace) return;
          navigate({
            to: "/launchpad/w/$workspaceId",
            params: { workspaceId: workspace.id },
            search: {},
          });
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <SpecEditorShell
        spec={input}
        onSpecChange={setInput}
        parse={parseStarterInput}
        renderVisual={(spec, onChange) => (
          <StarterVisualForm spec={spec} onChange={onChange} />
        )}
        footer={(api) => (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: "/settings/launchpad" })}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() => handleSave(api)}
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
            {starter ? (
              <Button
                type="button"
                variant="ghost"
                loading={launch.isPending}
                onClick={tryIt}
                title="Launch it yourself, exactly as your team would"
              >
                <Rocket />
                Try it
              </Button>
            ) : null}
          </>
        )}
      />
      {problems.length > 0 ? (
        <ul className="space-y-0.5 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── visual form ──────────────────────────────────────────────────────────

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function StarterVisualForm({
  spec,
  onChange,
}: {
  spec: StarterInput;
  onChange: (spec: StarterInput) => void;
}) {
  const id = useId();
  const toolboxes = useAllToolboxes();
  const recipe = spec.recipe;
  const setRecipe = (next: StarterInput["recipe"]) =>
    onChange({ ...spec, recipe: next });

  return (
    <div className="space-y-6">
      <Section
        title="What your team sees"
        hint="Plain words: this is the card on the Launchpad under “What are you working on?”."
      >
        <div className="space-y-1">
          <Label htmlFor={`${id}-title`}>Title</Label>
          <Input
            id={`${id}-title`}
            value={spec.title}
            maxLength={80}
            onChange={(e) => onChange({ ...spec, title: e.target.value })}
            placeholder="Edit the marketing site"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-description`}>Description</Label>
          <Input
            id={`${id}-description`}
            value={spec.description}
            maxLength={400}
            onChange={(e) => onChange({ ...spec, description: e.target.value })}
            placeholder="Change copy and images with the AI assistant, see it live."
          />
        </div>
        <div className="space-y-1">
          <Label>Icon</Label>
          <IconPicker
            value={spec.icon}
            onChange={(icon) => onChange({ ...spec, icon })}
          />
        </div>
        <label
          htmlFor={`${id}-published`}
          className="flex items-center gap-2 text-sm"
        >
          <Checkbox
            id={`${id}-published`}
            checked={spec.published ?? true}
            onChange={(e) => onChange({ ...spec, published: e.target.checked })}
          />
          Published on the Launchpad
        </label>
        <p className="-mt-2 text-xs text-muted-foreground">
          Unpublished starters stay here, and only their authors can try them.
        </p>
      </Section>

      <Section
        title="What boots"
        hint="A prebuild boots in seconds with the repo and dependencies already set up."
      >
        <BootSourceField recipe={recipe} onChange={setRecipe} />
        {toolboxes.length > 0 ? (
          <div className="space-y-1">
            <Label>Toolboxes</Label>
            <ToolboxPicker
              toolboxes={toolboxes}
              selected={new Set(recipe.toolboxes ?? [])}
              onToggle={(selector) => {
                const next = new Set(recipe.toolboxes ?? []);
                if (next.has(selector)) next.delete(selector);
                else next.add(selector);
                const { toolboxes: _drop, ...rest } = recipe;
                setRecipe(
                  next.size > 0 ? { ...rest, toolboxes: [...next] } : rest,
                );
              }}
            />
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
          <div className="space-y-1">
            <Label htmlFor={`${id}-vcpus`}>vCPUs</Label>
            <Input
              id={`${id}-vcpus`}
              type="number"
              min={1}
              value={recipe.resources.vcpus}
              onChange={(e) =>
                setRecipe({
                  ...recipe,
                  resources: {
                    ...recipe.resources,
                    vcpus: Math.max(1, Number(e.target.value) || 1),
                  },
                })
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-memory`}>Memory (MB)</Label>
            <Input
              id={`${id}-memory`}
              type="number"
              min={256}
              step={256}
              value={recipe.resources.memoryMb}
              onChange={(e) =>
                setRecipe({
                  ...recipe,
                  resources: {
                    ...recipe.resources,
                    memoryMb: Math.max(256, Number(e.target.value) || 256),
                  },
                })
              }
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Files, env, processes and hooks: switch to JSON and edit{" "}
          <code>recipe</code> (any <code>POST /v1/sandboxes</code> field).
        </p>
      </Section>

      <Section
        title="Tools"
        hint="The buttons your team gets in the workspace. Port tools are started automatically after launch and after every wake-up."
      >
        <ServicesField
          services={spec.services}
          onChange={(services) => onChange({ ...spec, services })}
          portSuggestions={portSuggestions(spec, toolboxes)}
        />
      </Section>

      <Section
        title="Guide"
        hint="Optional. Shown next to the tools: a few plain sentences on how to get going."
      >
        <textarea
          value={spec.guide ?? ""}
          maxLength={4000}
          onChange={(e) => onChange({ ...spec, guide: e.target.value })}
          placeholder={
            "1. Open the Assistant and describe the change you want.\n2. Check the result in Preview.\n3. Happy? Ask the Assistant to open a pull request."
          }
          className="min-h-28 w-full rounded-md border bg-muted/30 p-2 text-sm"
        />
      </Section>
    </div>
  );
}

/** Port names worth suggesting: the recipe's own ports plus those of every
 * applied toolbox (auto-injected or picked). */
function portSuggestions(
  spec: StarterInput,
  toolboxes: ToolboxConfig[],
): string[] {
  const picked = new Set(spec.recipe.toolboxes ?? []);
  const names = new Set<string>();
  for (const port of spec.recipe.ports ?? []) names.add(port.name);
  for (const tb of toolboxes) {
    const selector = `tb/${tb.ownerType}/${tb.ownerId}/${tb.slug}`;
    if (!tb.autoInject && !picked.has(selector)) continue;
    for (const port of tb.ports ?? []) if (port.public) names.add(port.name);
  }
  return [...names];
}

function IconPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (icon: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {LAUNCHPAD_ICONS.map((icon) => (
        <button
          key={icon}
          type="button"
          onClick={() => onChange(icon)}
          aria-label={icon}
          aria-pressed={value === icon}
          title={icon}
          className={cn(
            "flex size-9 items-center justify-center rounded-md border transition-colors",
            value === icon
              ? "border-foreground bg-foreground text-background"
              : "hover:bg-muted",
          )}
        >
          <LaunchpadIconView icon={icon} className="size-4" />
        </button>
      ))}
    </div>
  );
}

// ── boot source ──────────────────────────────────────────────────────────

function prebuildLabel(record: PrebuildRecord): string {
  const { url, branch } = prebuildRepoBranch(record);
  if (!url) return record.ref;
  const name = repoShortName(url);
  return branch ? `${name} (${branch})` : name;
}

/** The stored prebuild the recipe currently points at, if any: by recipe
 * (the follow-updates form) or by pinned snapshot ref. */
function matchPrebuild(
  recipe: StarterInput["recipe"],
  prebuilds: PrebuildRecord[],
): PrebuildRecord | undefined {
  if (recipe.prebuild) {
    const want = JSON.stringify(recipe.prebuild);
    return prebuilds.find((p) => p.spec && JSON.stringify(p.spec) === want);
  }
  if ("snapshot" in recipe.source) {
    const ref = recipe.source.snapshot;
    return prebuilds.find((p) => p.ref === ref);
  }
  return undefined;
}

function BootSourceField({
  recipe,
  onChange,
}: {
  recipe: StarterInput["recipe"];
  onChange: (recipe: StarterInput["recipe"]) => void;
}) {
  const defaultImage = useDefaultImage();
  const { data: prebuilds = [] } = useQuery(prebuildsListQuery());
  const usesPrebuild = !!recipe.prebuild || "snapshot" in recipe.source;
  const [mode, setMode] = useState<"prebuild" | "image">(
    usesPrebuild ? "prebuild" : "image",
  );
  const matched = matchPrebuild(recipe, prebuilds);

  function pickPrebuild(ref: string) {
    const record = prebuilds.find((p) => p.ref === ref);
    if (!record) return;
    const { prebuild: _drop, ...rest } = recipe;
    // With the recipe stored, every launch re-resolves it (a cache hit when
    // unchanged), so a rebuilt prebuild reaches new workspaces. Hand-made
    // snapshots without a recipe can only be pinned.
    onChange(
      record.spec
        ? { ...rest, source: record.spec.source, prebuild: record.spec }
        : { ...rest, source: { snapshot: record.ref } },
    );
  }

  function switchMode(next: "prebuild" | "image") {
    setMode(next);
    if (next === "image") {
      const { prebuild: _drop, ...rest } = recipe;
      onChange({
        ...rest,
        source:
          "image" in recipe.source && !recipe.prebuild
            ? recipe.source
            : { image: defaultImage },
      });
    }
  }

  return (
    <div className="space-y-2">
      <SegmentedControl
        options={[
          { value: "prebuild", label: "A prebuild" },
          { value: "image", label: "A base image" },
        ]}
        value={mode}
        onChange={switchMode}
      />
      {mode === "prebuild" ? (
        prebuilds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No prebuilds yet. Create one under Settings → Prebuilds.
          </p>
        ) : (
          <>
            <NativeSelect
              value={matched?.ref ?? ""}
              onChange={(e) => pickPrebuild(e.target.value)}
              aria-label="Prebuild"
            >
              <option value="" disabled>
                Pick a prebuild…
              </option>
              {prebuilds.map((p) => (
                <option key={p.ref} value={p.ref}>
                  {prebuildLabel(p)}
                </option>
              ))}
            </NativeSelect>
            {recipe.prebuild ? (
              <p className="text-xs text-muted-foreground">
                Follows this prebuild: when it's rebuilt, new workspaces get the
                fresh one.
              </p>
            ) : "snapshot" in recipe.source && !matched ? (
              <p className="text-xs text-warning">
                Pinned to <code>{recipe.source.snapshot}</code>, which no longer
                exists. Pick another one.
              </p>
            ) : null}
          </>
        )
      ) : (
        <ImageSourcePicker
          value={"image" in recipe.source ? recipe.source : { image: "" }}
          allowSnapshot={false}
          onChange={(source) => onChange({ ...recipe, source })}
        />
      )}
    </div>
  );
}

// ── services ─────────────────────────────────────────────────────────────

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

function ServicesField({
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
  const id = useId();
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
        {isPort ? (
          <label
            htmlFor={`${id}-autostart`}
            className="flex items-center gap-2 text-sm"
          >
            <Checkbox
              id={`${id}-autostart`}
              checked={service.autostart !== false}
              onChange={(e) =>
                onChange({
                  ...service,
                  autostart: e.target.checked ? undefined : false,
                })
              }
            />
            Start it automatically
          </label>
        ) : null}
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
