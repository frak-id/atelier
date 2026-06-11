import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface DevConfig {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
}

interface DevCommandsFormProps {
  dev: DevConfig | undefined;
  onChange: (dev: DevConfig | undefined) => void;
}

export function DevCommandsForm({ dev, onChange }: DevCommandsFormProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="dev-command">Command</Label>
        <Input
          id="dev-command"
          value={dev?.command ?? ""}
          onChange={(e) =>
            onChange({
              command: e.target.value,
              workdir: dev?.workdir,
              env: dev?.env,
            })
          }
          placeholder="npm run dev"
        />
        <p className="text-xs text-muted-foreground">
          Served at a public HTTPS URL. The server must listen on{" "}
          <code>$PORT</code> (injected) — most frameworks do by default;
          otherwise pass it explicitly (e.g. <code>--port $PORT</code>). No{" "}
          <code>server.host</code> or <code>allowedHosts</code> config needed.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="dev-workdir">Working directory (optional)</Label>
        <Input
          id="dev-workdir"
          value={dev?.workdir ?? ""}
          onChange={(e) =>
            onChange({
              command: dev?.command ?? "",
              workdir: e.target.value || undefined,
              env: dev?.env,
            })
          }
          placeholder="defaults to the first repository"
        />
      </div>
    </div>
  );
}
