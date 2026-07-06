import { useQuery } from "@tanstack/react-query";
import { capabilitiesQuery } from "@/api/queries/capabilities";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The name/description/icon/harness fields shared by both template dialogs
 * (`SaveAsTemplateDialog` promote-in-place, `TemplateDialog` settings author) —
 * factored out so the harness "not registered" check and the field markup live
 * in one place (design ui-evolution.md §5/D). Each dialog keeps its own unique
 * middle section (params list vs JSONC spec editor) and its own publish toggle
 * position, so this renders only the top block.
 */
export function TemplateMetaFields({
  idPrefix,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  icon,
  onIconChange,
  harness,
  autoFocusName,
  harnessHint,
}: {
  idPrefix: string;
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  icon: string;
  onIconChange: (value: string) => void;
  harness?: string;
  autoFocusName?: boolean;
  harnessHint?: string;
}) {
  const { data: capabilities } = useQuery(capabilitiesQuery());
  const unregistered =
    capabilities && harness && !capabilities.harnesses.includes(harness);

  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          required
          autoFocus={autoFocusName}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-description`}>
          Description (optional)
        </Label>
        <Input
          id={`${idPrefix}-description`}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="What this template is for"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-icon`}>Icon name (optional)</Label>
        <Input
          id={`${idPrefix}-icon`}
          value={icon}
          onChange={(e) => onIconChange(e.target.value)}
          placeholder="bot, code, terminal…"
          className="font-mono"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Harness: <span className="font-mono">{harness ?? "none"}</span>
        {unregistered ? " (not registered on this server)" : ""}
        {harness && harnessHint ? ` — ${harnessHint}` : ""}
      </p>
    </>
  );
}

/** The "publish to the gallery" toggle, shared by both template dialogs. */
export function TemplatePublishToggle({
  id,
  checked,
  onChange,
  label = "Publish to the gallery",
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
