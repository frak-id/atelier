import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface CommandsFormProps {
  initCommands: string;
  onInitCommandsChange: (value: string) => void;
}

export function CommandsForm({
  initCommands,
  onInitCommandsChange,
}: CommandsFormProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="initCommands">Init Commands (one per line)</Label>
        <Textarea
          id="initCommands"
          rows={4}
          value={initCommands}
          onChange={(e) => onInitCommandsChange(e.target.value)}
          placeholder="bun install&#10;bun run build"
        />
        <p className="text-xs text-muted-foreground">
          Commands run during prebuild to install dependencies and build assets.
        </p>
      </div>
    </div>
  );
}
