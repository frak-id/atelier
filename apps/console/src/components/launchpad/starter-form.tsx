import {
  LAUNCHPAD_ICONS,
  type StarterInput,
  type ToolboxConfig,
} from "@atelier/spec";
import { type ReactNode, useId } from "react";
import { StarterBootSource } from "@/components/launchpad/starter-boot-source";
import { StarterServices } from "@/components/launchpad/starter-services";
import { ToolboxPicker } from "@/components/toolbox-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAllToolboxes } from "@/hooks/use-all-toolboxes";
import { LaunchpadIconView } from "@/lib/launchpad";
import { cn } from "@/lib/utils";

/** The starter editor's visual mode: presentation, boot source, tools and
 * guide. */

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

export function StarterVisualForm({
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
        <StarterBootSource recipe={recipe} onChange={setRecipe} />
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
        <StarterServices
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
