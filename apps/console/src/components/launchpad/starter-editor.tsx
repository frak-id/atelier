import { type StarterInput, starterInputProblems } from "@atelier/spec";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Rocket } from "lucide-react";
import { useState } from "react";
import {
  type StarterRecord,
  useCreateStarter,
  useLaunchStarter,
  useUpdateStarter,
} from "@/api/queries/launchpad";
import { StarterVisualForm } from "@/components/launchpad/starter-form";
import {
  type SpecEditorApi,
  SpecEditorShell,
} from "@/components/spec-editor-shell";
import { Button } from "@/components/ui/button";
import { useDefaultImage } from "@/hooks/use-repo-catalog";
import { parseStarterInput } from "@/lib/spec";
import { blankStarterInput } from "@/lib/starter-recipe";

function toInput(
  starter: StarterRecord | undefined,
  image: string,
  initial: StarterInput | undefined,
) {
  if (!starter) return initial ?? blankStarterInput(image);
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

const GIT_URL_RE = /^(https?:\/\/|git@)/;

/** Visual-form problems the schema alone wouldn't catch, in author words. */
function formProblems(input: StarterInput): string[] {
  const problems = [...starterInputProblems(input)];
  if (!input.title.trim()) problems.push("Give the starter a title.");
  const { source } = input.recipe;
  if ("image" in source && !source.image.trim() && !input.recipe.prebuild) {
    problems.push("Pick what the workspace boots from.");
  }
  const repos = input.recipe.prebuild?.repos ?? [];
  const clonePaths = new Set<string>();
  for (const repo of repos) {
    if (!repo.url.trim() || !GIT_URL_RE.test(repo.url.trim())) {
      problems.push(
        "Every git repository needs a URL starting with https:// or git@.",
      );
    }
    if (!repo.clonePath.trim()) {
      problems.push("Every git repository needs a clone path.");
    } else if (clonePaths.has(repo.clonePath.trim())) {
      problems.push(`Clone path "${repo.clonePath.trim()}" is used twice.`);
    }
    clonePaths.add(repo.clonePath.trim());
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

/** Drop blank setup steps before saving — a stray blank line while typing
 * isn't a validation error, just noise to discard. */
function cleanInput(input: StarterInput): StarterInput {
  const { prebuild } = input.recipe;
  if (!prebuild?.build) return input;
  const build = prebuild.build.map((s) => s.trim()).filter(Boolean);
  return {
    ...input,
    recipe: {
      ...input.recipe,
      prebuild: { ...prebuild, build: build.length > 0 ? build : undefined },
    },
  };
}

/**
 * Author a Launchpad starter: what a non-technical user sees (title, icon,
 * description, guide), what boots (prebuild or image + toolboxes +
 * resources) and which tools to surface. The JSON mode exposes the whole
 * recipe (any `CreateSandboxRequest` field: files, env, processes, hooks…).
 *
 * A new starter's image comes from the server config: mount this once that
 * query has settled (settings.launchpad.new.tsx waits for it).
 */
export function StarterEditor({
  starter,
  owner,
  initial,
}: {
  starter?: StarterRecord;
  owner: string;
  /** Seeds a new starter's input (e.g. from `?prebuild=<ref>`); ignored when
   * editing an existing starter. */
  initial?: StarterInput;
}) {
  const navigate = useNavigate();
  const defaultImage = useDefaultImage();
  const create = useCreateStarter();
  const update = useUpdateStarter();
  const launch = useLaunchStarter();
  const [input, setInput] = useState<StarterInput>(() =>
    toInput(starter, defaultImage, initial),
  );
  const [problems, setProblems] = useState<string[]>([]);
  const pending = create.isPending || update.isPending;

  function handleSave(api: SpecEditorApi<StarterInput>) {
    const resolved = api.resolve();
    if (!resolved) return;
    const value = cleanInput(resolved);
    const found = formProblems(value);
    setProblems(found);
    if (found.length > 0) return;
    const back = () => navigate({ to: "/settings/launchpad" });
    if (starter) {
      update.mutate(
        {
          id: starter.id,
          // A full patch; `null` clears a removed icon/guide.
          patch: {
            ...value,
            icon: value.icon || null,
            guide: value.guide?.trim() ? value.guide : null,
          },
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
