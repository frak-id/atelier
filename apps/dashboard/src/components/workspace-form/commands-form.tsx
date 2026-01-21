import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface CommandsFormProps {
  initCommands: string;
  startCommands: string;
  onInitCommandsChange: (value: string) => void;
  onStartCommandsChange: (value: string) => void;
}

export function CommandsForm({
  initCommands,
  startCommands,
  onInitCommandsChange,
  onStartCommandsChange,
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
      </div>

      <div className="space-y-2">
        <Label htmlFor="startCommands">Start Commands (one per line)</Label>
        <Textarea
          id="startCommands"
          rows={3}
          value={startCommands}
          onChange={(e) => onStartCommandsChange(e.target.value)}
          placeholder="bun run dev &"
        />
      </div>
    </div>
  );
}
