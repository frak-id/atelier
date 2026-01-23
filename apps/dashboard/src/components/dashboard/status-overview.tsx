import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  CheckCircle,
  CircleDot,
  Clock,
  FileEdit,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface StatusCount {
  draft: number;
  queued: number;
  in_progress: number;
  pending_review: number;
  completed: number;
  attention: number;
}

interface StatusOverviewProps {
  counts: StatusCount;
}

const statusConfig = [
  {
    key: "attention" as const,
    label: "Attention",
    icon: AlertCircle,
    color: "text-red-500",
    bgColor: "bg-red-500/10",
    filter: "attention",
  },
  {
    key: "queued" as const,
    label: "Queued",
    icon: Clock,
    color: "text-yellow-500",
    bgColor: "bg-yellow-500/10",
    filter: "queued",
  },
  {
    key: "in_progress" as const,
    label: "Running",
    icon: CircleDot,
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    filter: "in_progress",
  },
  {
    key: "pending_review" as const,
    label: "Review",
    icon: FileEdit,
    color: "text-amber-500",
    bgColor: "bg-amber-500/10",
    filter: "pending_review",
  },
  {
    key: "completed" as const,
    label: "Done",
    icon: CheckCircle,
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    filter: "completed",
  },
];

export function StatusOverview({ counts }: StatusOverviewProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {statusConfig.map(
        ({ key, label, icon: Icon, color, bgColor, filter }) => (
          <Link
            key={key}
            to="/tasks"
            search={{ status: filter }}
            className="block"
          >
            <Card
              className={cn(
                "transition-colors hover:bg-accent/50 cursor-pointer",
                counts[key] > 0 && key === "attention" && "border-red-500/50",
              )}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className={cn("text-2xl font-bold", color)}>
                    {counts[key]}
                  </span>
                  <div className={cn("p-2 rounded-full", bgColor)}>
                    <Icon className={cn("h-4 w-4", color)} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{label}</p>
              </CardContent>
            </Card>
          </Link>
        ),
      )}
    </div>
  );
}
