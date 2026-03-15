import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Zap } from "lucide-react";
import { cliproxyUsageQuery } from "@/api/queries";
import { useExpandableSet } from "@/hooks/use-expandable-set";
import { formatCompact } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

type ModelUsage = { model: string; requests: number; tokens: number };

interface BreakdownRow {
  id: string;
  label: string;
  requests: number;
  tokens: number;
  models: ModelUsage[];
  mono?: boolean;
}

function UsageBreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: BreakdownRow[];
}) {
  const { expanded, toggle } = useExpandableSet();

  if (rows.length === 0) return null;

  return (
    <div className="mt-4 border-t pt-4">
      <h4 className="text-sm font-medium text-muted-foreground mb-3">
        {title}
      </h4>
      <div className="space-y-1">
        <div className="grid grid-cols-[1fr_100px_150px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground border-b">
          <div>{title.replace("Per ", "")}</div>
          <div>Requests</div>
          <div>Tokens</div>
        </div>
        {rows.map((row) => {
          const isExpanded = expanded.has(row.id);
          return (
            <div key={row.id} className="space-y-1">
              <button
                type="button"
                className="w-full grid grid-cols-[1fr_100px_150px] gap-2 px-3 py-2.5 text-sm items-center hover:bg-muted/50 rounded cursor-pointer text-left"
                onClick={() => toggle(row.id)}
              >
                <div
                  className={`font-medium truncate flex items-center gap-1 ${row.mono ? "font-mono" : ""}`}
                  title={row.label}
                >
                  <ChevronRight
                    className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                  />
                  {row.label}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {formatCompact(row.requests)}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {formatCompact(row.tokens)}
                </div>
              </button>
              {isExpanded && (
                <div className="space-y-1 pb-2">
                  {row.models.map((model) => (
                    <div
                      key={model.model}
                      className="grid grid-cols-[1fr_100px_150px] gap-2 px-3 py-2 text-xs items-center bg-muted/30 rounded pl-6"
                    >
                      <div
                        className="truncate text-muted-foreground"
                        title={model.model}
                      >
                        {model.model}
                      </div>
                      <div className="text-muted-foreground font-mono">
                        {formatCompact(model.requests)}
                      </div>
                      <div className="text-muted-foreground font-mono">
                        {formatCompact(model.tokens)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TokenUsageCard() {
  const { data: usage, isLoading } = useQuery(cliproxyUsageQuery);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Token Usage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!usage) return null;

  const developerRows: BreakdownRow[] = (usage.developers ?? []).map((dev) => ({
    id: dev.username,
    label: dev.username,
    requests: dev.totalRequests,
    tokens: dev.totalTokens,
    models: dev.models,
  }));

  const sandboxRows: BreakdownRow[] = Object.entries(usage.sandboxes ?? {})
    .sort(([, a], [, b]) => b.totalTokens - a.totalTokens)
    .map(([id, sbx]) => ({
      id,
      label: id,
      requests: sbx.totalRequests,
      tokens: sbx.totalTokens,
      models: sbx.models,
      mono: true,
    }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5" />
          Token Usage
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div>
            <div className="text-xs text-muted-foreground">Total Tokens</div>
            <div className="text-xl font-bold">
              {formatCompact(usage.global.totalTokens)}
            </div>
            {usage.global.today && (
              <div className="text-xs text-muted-foreground mt-1">
                Today: {formatCompact(usage.global.today.tokens)}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Total Requests</div>
            <div className="text-xl font-bold">
              {formatCompact(usage.global.totalRequests)}
            </div>
            {usage.global.today && (
              <div className="text-xs text-muted-foreground mt-1">
                Today: {formatCompact(usage.global.today.requests)}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Success</div>
            <div className="text-xl font-bold">
              {formatCompact(usage.global.successCount)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Failed</div>
            <div className="text-xl font-bold">
              {formatCompact(usage.global.failureCount)}
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <div className="grid grid-cols-[1fr_100px_150px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground border-b">
            <div>Model</div>
            <div>Requests</div>
            <div>Tokens</div>
          </div>
          {usage.global.models.map((model) => (
            <div
              key={model.model}
              className="grid grid-cols-[1fr_100px_150px] gap-2 px-3 py-2.5 text-sm items-center hover:bg-muted/50 rounded"
            >
              <div className="font-medium truncate" title={model.model}>
                {model.model}
              </div>
              <div className="text-xs text-muted-foreground font-mono">
                {formatCompact(model.requests)}
              </div>
              <div className="text-xs text-muted-foreground font-mono">
                {formatCompact(model.tokens)}
              </div>
            </div>
          ))}
        </div>

        <UsageBreakdownTable title="Per Developer" rows={developerRows} />
        <UsageBreakdownTable title="Per Sandbox" rows={sandboxRows} />
      </CardContent>
    </Card>
  );
}
