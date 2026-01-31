import type {
  PermissionRequest,
  QuestionInfo,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  useRejectQuestion,
  useReplyPermission,
  useReplyQuestion,
} from "@/api/queries/opencode";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  formatSessionId,
  getQuestionDisplayText,
  truncateText,
} from "@/lib/intervention-helpers";
import { cn } from "@/lib/utils";

type ExpandableInterventionsProps = {
  permissions: Array<PermissionRequest & { sessionId: string }>;
  questions: Array<QuestionRequest & { sessionId: string }>;
  compact?: boolean;
  opencodeUrl?: string;
  questionsAsLink?: boolean;
  onQuestionClick?: () => void;
};

export function ExpandableInterventions({
  permissions,
  questions,
  compact = false,
  opencodeUrl,
  questionsAsLink = false,
  onQuestionClick,
}: ExpandableInterventionsProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const totalCount = permissions.length + questions.length;

  if (totalCount === 0) {
    return null;
  }

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div
        className={cn(
          "border border-amber-200 bg-amber-50 rounded-md",
          compact ? "p-2" : "p-3",
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
          >
            <AlertTriangle
              className={cn(
                "text-amber-600 shrink-0",
                compact ? "h-3 w-3" : "h-4 w-4",
              )}
            />
            <span
              className={cn(
                "font-medium text-amber-900 flex-1",
                compact ? "text-xs" : "text-sm",
              )}
            >
              {totalCount} action{totalCount !== 1 ? "s" : ""} needed
            </span>
            {isExpanded ? (
              <ChevronDown
                className={cn(
                  "text-amber-600",
                  compact ? "h-3 w-3" : "h-4 w-4",
                )}
              />
            ) : (
              <ChevronRight
                className={cn(
                  "text-amber-600",
                  compact ? "h-3 w-3" : "h-4 w-4",
                )}
              />
            )}
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className={cn("space-y-3", compact ? "mt-2" : "mt-3")}>
            {permissions.length > 0 && (
              <div>
                <h4
                  className={cn(
                    "font-semibold text-amber-900 mb-2",
                    compact ? "text-xs" : "text-sm",
                  )}
                >
                  Permissions ({permissions.length})
                </h4>
                <div className="space-y-2">
                  {permissions.map((p) => (
                    <PermissionRow
                      key={p.id}
                      permission={p}
                      compact={compact}
                      opencodeUrl={opencodeUrl}
                    />
                  ))}
                </div>
              </div>
            )}

            {questions.length > 0 && (
              <div>
                <h4
                  className={cn(
                    "font-semibold text-amber-900 mb-2",
                    compact ? "text-xs" : "text-sm",
                  )}
                >
                  Questions ({questions.length})
                </h4>
                {questionsAsLink ? (
                  <button
                    type="button"
                    onClick={onQuestionClick}
                    className={cn(
                      "text-amber-800 hover:text-amber-950 underline underline-offset-2 transition-colors",
                      compact ? "text-xs" : "text-sm",
                    )}
                  >
                    Answer in Drawer →
                  </button>
                ) : (
                  <div className="space-y-2">
                    {questions.map((q) => (
                      <QuestionRow
                        key={q.id}
                        question={q}
                        compact={compact}
                        opencodeUrl={opencodeUrl}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function PermissionRow({
  permission,
  compact,
  opencodeUrl,
}: {
  permission: PermissionRequest & { sessionId: string };
  compact: boolean;
  opencodeUrl?: string;
}) {
  const [clickedAction, setClickedAction] = useState<"once" | "reject" | null>(
    null,
  );
  const replyMutation = useReplyPermission(opencodeUrl ?? "");

  const handleReply = (reply: "once" | "reject") => {
    if (!opencodeUrl) return;
    setClickedAction(reply);
    replyMutation.mutate(
      { requestID: permission.id, reply },
      {
        onSuccess: () => {
          toast.success(
            reply === "once" ? "Permission approved" : "Permission denied",
          );
          setClickedAction(null);
        },
        onError: (error) => {
          const isGone =
            error instanceof Error &&
            (error.message.includes("404") || error.message.includes("gone"));
          if (isGone) {
            toast.error("Permission request expired");
          } else {
            toast.error(
              `Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            );
          }
          setClickedAction(null);
        },
      },
    );
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-amber-800",
        compact ? "text-xs" : "text-sm",
      )}
    >
      <Badge variant="outline" className="shrink-0 text-xs bg-white">
        {formatSessionId(permission.sessionID)}
      </Badge>
      <span className="font-medium flex-1 min-w-0 truncate">
        {permission.permission}
      </span>
      {opencodeUrl && (
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="default"
            size="sm"
            className="h-6 px-2 text-xs gap-1"
            disabled={replyMutation.isPending}
            onClick={(e) => {
              e.stopPropagation();
              handleReply("once");
            }}
          >
            {clickedAction === "once" && replyMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            Allow Once
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-6 px-2 text-xs gap-1"
            disabled={replyMutation.isPending}
            onClick={(e) => {
              e.stopPropagation();
              handleReply("reject");
            }}
          >
            {clickedAction === "reject" && replyMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <X className="h-3 w-3" />
            )}
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}

function QuestionRow({
  question,
  compact,
  opencodeUrl,
}: {
  question: QuestionRequest & { sessionId: string };
  compact: boolean;
  opencodeUrl?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className={cn(
        "text-amber-800 rounded border border-amber-200/60 bg-white/50",
        compact ? "text-xs" : "text-sm",
      )}
    >
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left p-2 hover:bg-amber-50/50 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <Badge variant="outline" className="shrink-0 text-xs bg-white">
          {formatSessionId(question.sessionID)}
        </Badge>
        <span className="flex-1 min-w-0 break-words">
          {truncateText(getQuestionDisplayText(question), compact ? 120 : 200)}
        </span>
        {isOpen ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-amber-600" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-amber-600" />
        )}
      </button>
      {isOpen && opencodeUrl && (
        <QuestionForm question={question} opencodeUrl={opencodeUrl} />
      )}
    </div>
  );
}

function QuestionForm({
  question,
  opencodeUrl,
}: {
  question: QuestionRequest & { sessionId: string };
  opencodeUrl: string;
}) {
  const replyMutation = useReplyQuestion(opencodeUrl);
  const rejectMutation = useRejectQuestion(opencodeUrl);

  const [answers, setAnswers] = useState<Array<Array<string>>>(() =>
    question.questions.map(() => []),
  );
  const [customTexts, setCustomTexts] = useState<Array<string>>(() =>
    question.questions.map(() => ""),
  );

  const isPending = replyMutation.isPending || rejectMutation.isPending;

  const updateAnswer = (
    qIdx: number,
    info: QuestionInfo,
    value: string,
    checked: boolean,
  ) => {
    setAnswers((prev) => {
      const next = [...prev];
      if (info.multiple) {
        const current = new Set(next[qIdx]);
        if (checked) current.add(value);
        else current.delete(value);
        next[qIdx] = [...current];
      } else {
        next[qIdx] = checked ? [value] : [];
      }
      return next;
    });
  };

  const handleSubmit = () => {
    const finalAnswers = answers.map((selected, idx) => {
      const custom = customTexts[idx]?.trim();
      if (custom) return [...selected, custom];
      return selected;
    });

    replyMutation.mutate(
      { requestID: question.id, answers: finalAnswers },
      {
        onSuccess: () => {
          toast.success("Answer submitted");
        },
        onError: (error) => {
          toast.error(
            `Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        },
      },
    );
  };

  const handleSkip = () => {
    rejectMutation.mutate(question.id, {
      onSuccess: () => {
        toast.success("Question skipped");
      },
      onError: (error) => {
        toast.error(
          `Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      },
    });
  };

  return (
    <div className="border-t border-amber-200/60 p-3 space-y-4">
      {question.questions.map((info, qIdx) => (
        <div key={info.header} className="space-y-2">
          <p className="font-medium text-amber-900 text-sm">{info.question}</p>

          <div className="space-y-1.5 pl-1">
            {info.options.map((opt) => {
              const isSelected = answers[qIdx]?.includes(opt.label) ?? false;
              const inputId = `${question.id}-${qIdx}-${opt.label}`;

              return (
                <label
                  key={opt.label}
                  htmlFor={inputId}
                  className={cn(
                    "flex items-start gap-2 p-1.5 rounded cursor-pointer transition-colors",
                    isSelected ? "bg-amber-100/80" : "hover:bg-amber-50/50",
                  )}
                >
                  {info.multiple ? (
                    <Checkbox
                      id={inputId}
                      checked={isSelected}
                      onChange={(e) =>
                        updateAnswer(
                          qIdx,
                          info,
                          opt.label,
                          (e.target as HTMLInputElement).checked,
                        )
                      }
                      className="mt-0.5"
                    />
                  ) : (
                    <input
                      type="radio"
                      id={inputId}
                      name={`${question.id}-${qIdx}`}
                      checked={isSelected}
                      onChange={(e) =>
                        updateAnswer(qIdx, info, opt.label, e.target.checked)
                      }
                      className="mt-0.5 h-4 w-4 accent-amber-600"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{opt.label}</span>
                    {opt.description && (
                      <p className="text-xs text-amber-700/70 mt-0.5">
                        {opt.description}
                      </p>
                    )}
                  </div>
                </label>
              );
            })}
          </div>

          {info.custom !== false && (
            <input
              type="text"
              placeholder="Or type your answer"
              value={customTexts[qIdx] ?? ""}
              onChange={(e) =>
                setCustomTexts((prev) => {
                  const next = [...prev];
                  next[qIdx] = e.target.value;
                  return next;
                })
              }
              className="w-full px-2 py-1.5 text-sm border border-amber-200 rounded bg-white placeholder:text-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
            />
          )}
        </div>
      ))}

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          disabled={isPending}
          onClick={handleSubmit}
        >
          {replyMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : null}
          Submit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 text-xs text-amber-700"
          disabled={isPending}
          onClick={handleSkip}
        >
          {rejectMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : null}
          Skip
        </Button>
      </div>
    </div>
  );
}
