import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAddPort } from "@/api/queries/sandboxes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ExposePortSection({ sandboxId }: { sandboxId: string }) {
  const addPort = useAddPort(sandboxId);
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [isPublic, setIsPublic] = useState(true);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const portNumber = Number(port);
    if (
      !name ||
      !Number.isInteger(portNumber) ||
      portNumber < 1 ||
      portNumber > 65535
    )
      return;
    addPort.mutate(
      { name, port: portNumber, public: isPublic },
      {
        onSuccess: () => {
          setName("");
          setPort("");
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Expose port</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="port-name">Name</Label>
            <Input
              id="port-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="web"
              required
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor="port-number">Port</Label>
            <Input
              id="port-number"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="3000"
              required
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="port-public"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            <Label htmlFor="port-public">Public</Label>
          </div>
          <Button type="submit" disabled={addPort.isPending}>
            {addPort.isPending ? <Loader2 className="animate-spin" /> : null}
            Expose
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
