import type { ServiceStatus } from "@frak/atelier-manager/types";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useServiceStart, useServiceStop } from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ServicesTab({
  sandboxId,
  services,
}: {
  sandboxId: string;
  services?: ServiceStatus[];
}) {
  const stopMutation = useServiceStop(sandboxId);
  const restartMutation = useServiceStart(sandboxId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Services</CardTitle>
      </CardHeader>
      <CardContent>
        {services && services.length > 0 ? (
          <div className="space-y-2">
            {services.map((service) => (
              <div
                key={service.name}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 border-b last:border-0"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="font-medium text-sm truncate">
                    {service.name}
                  </div>
                  {service.pid ? (
                    <span className="text-xs text-muted-foreground font-mono shrink-0">
                      PID: {service.pid}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
                  <Badge
                    variant={
                      service.running
                        ? "success"
                        : service.status === "error"
                          ? "error"
                          : "secondary"
                    }
                    className="h-5 px-1.5"
                  >
                    {service.running
                      ? "Running"
                      : service.status === "error"
                        ? `Exit ${service.exitCode ?? "?"}`
                        : "Stopped"}
                  </Badge>
                  {service.running ? (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => restartMutation.mutate(service.name)}
                            disabled={restartMutation.isPending}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Restart</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => stopMutation.mutate(service.name)}
                            disabled={stopMutation.isPending}
                          >
                            <Pause className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Stop</TooltipContent>
                      </Tooltip>
                    </>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => restartMutation.mutate(service.name)}
                          disabled={restartMutation.isPending}
                        >
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Start</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No services detected</p>
        )}
      </CardContent>
    </Card>
  );
}
