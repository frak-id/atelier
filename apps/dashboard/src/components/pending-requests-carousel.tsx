import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import {
  ChevronLeft,
  ChevronRight,
  MessageCircleQuestion,
  Shield,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PendingRequestsCarouselProps = {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  className?: string;
};

type CarouselItem =
  | { type: "permission"; data: PermissionRequest }
  | { type: "question"; data: QuestionRequest };

export function PendingRequestsCarousel({
  permissions,
  questions,
  className,
}: PendingRequestsCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  const items: CarouselItem[] = [
    ...permissions.map((p) => ({ type: "permission" as const, data: p })),
    ...questions.map((q) => ({ type: "question" as const, data: q })),
  ];

  if (items.length === 0) {
    return null;
  }

  const currentItem = items[currentIndex];
  const hasMultiple = items.length > 1;

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? items.length - 1 : prev - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === items.length - 1 ? 0 : prev + 1));
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {hasMultiple && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 shrink-0"
          onClick={goToPrevious}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
      )}

      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {currentItem?.type === "permission" ? (
          <PermissionDisplay permission={currentItem.data} />
        ) : currentItem?.type === "question" ? (
          <QuestionDisplay question={currentItem.data} />
        ) : null}

        {hasMultiple && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {currentIndex + 1}/{items.length}
          </span>
        )}
      </div>

      {hasMultiple && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 shrink-0"
          onClick={goToNext}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

function PermissionDisplay({ permission }: { permission: PermissionRequest }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0 px-2 py-1 rounded bg-purple-100 dark:bg-purple-950 border border-purple-300 dark:border-purple-700">
      <Shield className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
      <span className="text-xs text-purple-700 dark:text-purple-300 truncate">
        {permission.permission}
      </span>
    </div>
  );
}

function QuestionDisplay({ question }: { question: QuestionRequest }) {
  const firstQuestion = question.questions[0];
  const displayText =
    firstQuestion?.header || firstQuestion?.question || "Question";

  return (
    <div className="flex items-center gap-1.5 min-w-0 px-2 py-1 rounded bg-cyan-100 dark:bg-cyan-950 border border-cyan-300 dark:border-cyan-700">
      <MessageCircleQuestion className="h-3.5 w-3.5 text-cyan-600 dark:text-cyan-400 shrink-0" />
      <span className="text-xs text-cyan-700 dark:text-cyan-300 truncate">
        {displayText}
      </span>
    </div>
  );
}

export function PendingRequestsBadges({
  permissions,
  questions,
  compact = false,
}: {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  compact?: boolean;
}) {
  if (permissions.length === 0 && questions.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1">
      {permissions.length > 0 && (
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-950 border border-purple-300 dark:border-purple-700">
          <Shield className="h-3 w-3 text-purple-600 dark:text-purple-400" />
          {!compact && (
            <span className="text-[10px] text-purple-700 dark:text-purple-300">
              {permissions.length}
            </span>
          )}
        </div>
      )}
      {questions.length > 0 && (
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-100 dark:bg-cyan-950 border border-cyan-300 dark:border-cyan-700">
          <MessageCircleQuestion className="h-3 w-3 text-cyan-600 dark:text-cyan-400" />
          {!compact && (
            <span className="text-[10px] text-cyan-700 dark:text-cyan-300">
              {questions.length}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
