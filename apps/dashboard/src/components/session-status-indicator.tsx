import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import {
  Circle,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
  Shield,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MappedSessionStatus } from "@/hooks/use-task-session-progress";
import { cn } from "@/lib/utils";

export type SessionInteractionInfo = {
  status: MappedSessionStatus;
  pendingPermissions: PermissionRequest[];
  pendingQuestions: QuestionRequest[];
};

type SessionStatusIndicatorProps = {
  interaction: SessionInteractionInfo | null;
  isLoading?: boolean;
  compact?: boolean;
};

const STATUS_CONFIG: Record<
  MappedSessionStatus,
  {
    label: string;
    color: string;
    bgColor: string;
    icon: React.ReactNode;
  }
> = {
  idle: {
    label: "Waiting for input",
    color: "text-amber-600 dark:text-amber-400",
    bgColor:
      "bg-amber-100 dark:bg-amber-950 border-amber-300 dark:border-amber-700",
    icon: <Circle className="h-2.5 w-2.5 fill-amber-500 text-amber-500" />,
  },
  busy: {
    label: "Working",
    color: "text-blue-600 dark:text-blue-400",
    bgColor:
      "bg-blue-100 dark:bg-blue-950 border-blue-300 dark:border-blue-700",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
  },
  waiting: {
    label: "Retrying",
    color: "text-orange-600 dark:text-orange-400",
    bgColor:
      "bg-orange-100 dark:bg-orange-950 border-orange-300 dark:border-orange-700",
    icon: <RefreshCw className="h-3 w-3" />,
  },
  unknown: {
    label: "Unknown",
    color: "text-muted-foreground",
    bgColor: "bg-muted border-muted",
    icon: <Circle className="h-2.5 w-2.5" />,
  },
};

export function SessionStatusIndicator({
  interaction,
  isLoading,
  compact = false,
}: SessionStatusIndicatorProps) {
  if (isLoading) {
    return (
      <Badge variant="outline" className="gap-1 text-xs">
        <Loader2 className="h-3 w-3 animate-spin" />
        {!compact && "Loading..."}
      </Badge>
    );
  }

  if (!interaction) {
    return null;
  }

  const { status, pendingPermissions, pendingQuestions } = interaction;
  const config = STATUS_CONFIG[status];
  const hasPermissions = pendingPermissions.length > 0;
  const hasQuestions = pendingQuestions.length > 0;
  const needsAttention = hasPermissions || hasQuestions;

  if (needsAttention) {
    return (
      <div className="flex items-center gap-1">
        {hasPermissions && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(
                  "gap-1 text-xs cursor-help",
                  "bg-purple-100 dark:bg-purple-950 border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300",
                )}
              >
                <Shield className="h-3 w-3" />
                {!compact && (
                  <span>
                    {pendingPermissions.length} permission
                    {pendingPermissions.length > 1 ? "s" : ""}
                  </span>
                )}
                {compact && pendingPermissions.length}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <div className="space-y-1">
                <p className="font-medium">Permissions Requested:</p>
                <ul className="text-xs space-y-0.5">
                  {pendingPermissions.slice(0, 3).map((p) => (
                    <li key={p.id} className="truncate">
                      {p.permission}
                    </li>
                  ))}
                  {pendingPermissions.length > 3 && (
                    <li className="text-muted-foreground">
                      +{pendingPermissions.length - 3} more
                    </li>
                  )}
                </ul>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
        {hasQuestions && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(
                  "gap-1 text-xs cursor-help",
                  "bg-cyan-100 dark:bg-cyan-950 border-cyan-300 dark:border-cyan-700 text-cyan-700 dark:text-cyan-300",
                )}
              >
                <MessageCircleQuestion className="h-3 w-3" />
                {!compact && (
                  <span>
                    {pendingQuestions.length} question
                    {pendingQuestions.length > 1 ? "s" : ""}
                  </span>
                )}
                {compact && pendingQuestions.length}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <div className="space-y-1">
                <p className="font-medium">Questions Asked:</p>
                <ul className="text-xs space-y-0.5">
                  {pendingQuestions.slice(0, 3).map((q) => (
                    <li key={q.id} className="truncate">
                      {q.questions[0]?.header ??
                        q.questions[0]?.question ??
                        "Question"}
                    </li>
                  ))}
                  {pendingQuestions.length > 3 && (
                    <li className="text-muted-foreground">
                      +{pendingQuestions.length - 3} more
                    </li>
                  )}
                </ul>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }

  if (status === "idle") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "gap-1 text-xs cursor-help",
              config.bgColor,
              config.color,
            )}
          >
            {config.icon}
            {!compact && config.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <span>Session is idle - waiting for human input</span>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (status === "busy") {
    return (
      <Badge
        variant="outline"
        className={cn("gap-1 text-xs", config.bgColor, config.color)}
      >
        {config.icon}
        {!compact && config.label}
      </Badge>
    );
  }

  if (status === "waiting") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "gap-1 text-xs cursor-help",
              config.bgColor,
              config.color,
            )}
          >
            {config.icon}
            {!compact && config.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <span>Session is retrying after an error</span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return null;
}

export function SessionStatusDot({
  status,
  className,
}: {
  status: MappedSessionStatus;
  className?: string;
}) {
  const dotColors: Record<MappedSessionStatus, string> = {
    idle: "bg-amber-500",
    busy: "bg-blue-500 animate-pulse",
    waiting: "bg-orange-500",
    unknown: "bg-muted-foreground",
  };

  const labels: Record<MappedSessionStatus, string> = {
    idle: "Waiting for input",
    busy: "Working",
    waiting: "Retrying",
    unknown: "Unknown",
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full cursor-help",
            dotColors[status],
            className,
          )}
        />
      </TooltipTrigger>
      <TooltipContent>
        <span>{labels[status]}</span>
      </TooltipContent>
    </Tooltip>
  );
}
