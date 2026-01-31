import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  Loader2,
  MessageCircleQuestion,
  Shield,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";
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
import { Input } from "@/components/ui/input";
import {
  formatSessionId,
  getQuestionDisplayText,
} from "@/lib/intervention-helpers";
import { cn } from "@/lib/utils";

type AttentionBlockProps = {
  permissions: Array<PermissionRequest & { sessionId: string }>;
  questions: Array<QuestionRequest & { sessionId: string }>;
  opencodeUrl: string;
  sandboxId?: string;
  workspaceName?: string;
  onOpenSandbox?: (sandboxId: string) => void;
};

export function AttentionBlock({
  permissions,
  questions,
  opencodeUrl,
  sandboxId,
  workspaceName,
  onOpenSandbox,
}: AttentionBlockProps) {
  const totalCount = permissions.length + questions.length;
  if (totalCount === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-500/20">
        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
        <span className="text-sm font-medium text-amber-400 flex-1">
          {totalCount} action{totalCount !== 1 ? "s" : ""} needed
        </span>
        {sandboxId && onOpenSandbox && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => onOpenSandbox(sandboxId)}
          >
            <ExternalLink className="h-3 w-3" />
            Open Sandbox
          </Button>
        )}
        {sandboxId && workspaceName && !onOpenSandbox && (
          <span className="text-xs text-muted-foreground">{workspaceName}</span>
        )}
      </div>

      <div className="divide-y divide-amber-500/10">
        {permissions.map((p) => (
          <PermissionRow key={p.id} permission={p} opencodeUrl={opencodeUrl} />
        ))}
        {questions.map((q) => (
          <QuestionRow key={q.id} question={q} opencodeUrl={opencodeUrl} />
        ))}
      </div>
    </div>
  );
}

function PermissionRow({
  permission,
  opencodeUrl,
}: {
  permission: PermissionRequest & { sessionId: string };
  opencodeUrl: string;
}) {
  const replyMutation = useReplyPermission(opencodeUrl);
  const [clickedAction, setClickedAction] = useState<"once" | "reject" | null>(
    null,
  );

  const handleReply = (reply: "once" | "reject") => {
    setClickedAction(reply);
    replyMutation.mutate(
      { requestID: permission.id, reply },
      {
        onSuccess: () => {
          toast.success(
            reply === "once" ? "Permission approved" : "Permission denied",
          );
        },
        onError: (error) => {
          setClickedAction(null);
          const is404 = error instanceof Error && error.message.includes("404");
          toast.error(is404 ? "Permission request expired" : "Failed to reply");
        },
      },
    );
  };

  const isPending = replyMutation.isPending;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Shield className="h-4 w-4 text-purple-400 shrink-0" />
      <Badge variant="outline" className="shrink-0 text-xs">
        {formatSessionId(permission.sessionID)}
      </Badge>
      <span className="text-sm flex-1 min-w-0 truncate">
        {permission.permission}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="sm"
          variant="default"
          className="h-7 text-xs gap-1 px-2.5"
          disabled={isPending}
          onClick={() => handleReply("once")}
        >
          {isPending && clickedAction === "once" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          Allow Once
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="h-7 text-xs gap-1 px-2.5"
          disabled={isPending}
          onClick={() => handleReply("reject")}
        >
          {isPending && clickedAction === "reject" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <X className="h-3 w-3" />
          )}
          Deny
        </Button>
      </div>
    </div>
  );
}

function QuestionRow({
  question,
  opencodeUrl,
}: {
  question: QuestionRequest & { sessionId: string };
  opencodeUrl: string;
}) {
  const [selections, setSelections] = useState<Map<number, Set<string>>>(
    () => new Map(),
  );
  const [customInputs, setCustomInputs] = useState<Map<number, string>>(
    () => new Map(),
  );
  const [currentIdx, setCurrentIdx] = useState(0);

  const replyMutation = useReplyQuestion(opencodeUrl);
  const rejectMutation = useRejectQuestion(opencodeUrl);

  const totalQuestions = question.questions.length;
  const isLastQuestion = currentIdx >= totalQuestions - 1;

  const handleSubmit = useCallback(() => {
    const answers: Array<Array<string>> = question.questions.map((_, idx) => {
      const selected = selections.get(idx) ?? new Set();
      const custom = customInputs.get(idx)?.trim() ?? "";
      const result = [...selected];
      if (custom) result.push(custom);
      return result;
    });

    replyMutation.mutate(
      { requestID: question.id, answers },
      {
        onSuccess: () => toast.success("Answer submitted"),
        onError: (error) => {
          const is404 = error instanceof Error && error.message.includes("404");
          toast.error(is404 ? "Question expired" : "Failed to submit answer");
        },
      },
    );
  }, [question, selections, customInputs, replyMutation]);

  const handleSkip = useCallback(() => {
    rejectMutation.mutate(question.id, {
      onSuccess: () => toast.success("Question skipped"),
      onError: (error) => {
        const is404 = error instanceof Error && error.message.includes("404");
        toast.error(is404 ? "Question expired" : "Failed to skip question");
      },
    });
  }, [question.id, rejectMutation]);

  const toggleOption = useCallback(
    (questionIdx: number, label: string, multiple: boolean) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const current = new Set(next.get(questionIdx) ?? []);
        if (multiple) {
          if (current.has(label)) current.delete(label);
          else current.add(label);
        } else {
          current.clear();
          current.add(label);
        }
        next.set(questionIdx, current);
        return next;
      });

      // Auto-advance for single-select
      if (!multiple) {
        setTimeout(() => {
          if (questionIdx < totalQuestions - 1) {
            setCurrentIdx(questionIdx + 1);
          }
        }, 300);
      }
    },
    [totalQuestions],
  );

  const advanceToNext = useCallback(() => {
    if (!isLastQuestion) {
      setCurrentIdx((i) => i + 1);
    }
  }, [isLastQuestion]);

  const getAnswerSummary = useCallback(
    (idx: number): string | null => {
      const selected = selections.get(idx);
      const custom = customInputs.get(idx)?.trim();
      const parts: string[] = [];
      if (selected?.size) parts.push(...selected);
      if (custom) parts.push(custom);
      if (parts.length === 0) return null;
      const summary = parts.join(", ");
      return summary.length > 50 ? `${summary.slice(0, 47)}...` : summary;
    },
    [selections, customInputs],
  );

  const isPending = replyMutation.isPending || rejectMutation.isPending;

  const qi = question.questions[currentIdx];
  const isMultiple = qi?.multiple ?? false;
  const allowCustom = qi?.custom !== false;
  const selected = selections.get(currentIdx) ?? new Set();
  const hasCustomValue = (customInputs.get(currentIdx)?.trim() ?? "") !== "";
  const needsNextButton = isMultiple || allowCustom;

  return (
    <Collapsible className="group/question">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-amber-500/5 transition-colors"
        >
          <MessageCircleQuestion className="h-4 w-4 text-cyan-400 shrink-0" />
          <Badge variant="outline" className="shrink-0 text-xs">
            {formatSessionId(question.sessionID)}
          </Badge>
          <span className="text-sm flex-1 min-w-0 truncate">
            {getQuestionDisplayText(question)}
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 transition-transform group-data-[state=open]/question:rotate-90" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-4 pt-1 space-y-3">
          {/* Step navbar */}
          <div className="flex gap-1 overflow-x-auto pb-1">
            {question.questions.map((q, idx) => {
              const answer = getAnswerSummary(idx);
              const isCurrent = idx === currentIdx;
              return (
                <button
                  type="button"
                  key={q.header}
                  onClick={() => setCurrentIdx(idx)}
                  className={cn(
                    "flex flex-col items-start shrink-0 rounded-md px-2.5 py-1.5 text-xs transition-all border min-w-0",
                    isCurrent
                      ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                      : answer
                        ? "border-emerald-500/30 bg-emerald-500/5 text-muted-foreground"
                        : "border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <span className="flex items-center gap-1 font-medium truncate max-w-[140px]">
                    {answer && (
                      <Check className="h-3 w-3 text-emerald-400 shrink-0" />
                    )}
                    {!answer && !isCurrent && (
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                    )}
                    {q.header}
                  </span>
                  {answer && (
                    <span className="text-[10px] text-muted-foreground/70 truncate max-w-[140px]">
                      {answer}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Current question */}
          {qi && (
            <div className="space-y-2">
              <p className="font-medium text-sm text-foreground">
                {qi.question}
              </p>

              {qi.options.length > 0 && (
                <div className="grid gap-1.5">
                  {qi.options.map((opt) => {
                    const isSelected = selected.has(opt.label);
                    return (
                      <button
                        type="button"
                        key={opt.label}
                        onClick={() =>
                          toggleOption(currentIdx, opt.label, isMultiple)
                        }
                        className={cn(
                          "flex items-start gap-2.5 border rounded-lg p-3 cursor-pointer transition-all w-full text-left",
                          isSelected
                            ? "border-amber-500 bg-amber-500/8 shadow-[0_0_8px_rgba(245,158,11,0.08)]"
                            : "border-border hover:border-amber-500/30 hover:bg-muted/40",
                        )}
                      >
                        {isMultiple ? (
                          <Checkbox
                            checked={isSelected}
                            readOnly
                            className="mt-0.5 pointer-events-none shrink-0"
                          />
                        ) : (
                          <span
                            className={cn(
                              "mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors",
                              isSelected
                                ? "border-amber-500 bg-amber-500"
                                : "border-muted-foreground/40",
                            )}
                          >
                            {isSelected && (
                              <span className="h-1.5 w-1.5 rounded-full bg-black" />
                            )}
                          </span>
                        )}
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-sm">
                            {opt.label}
                          </span>
                          {opt.description && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {opt.description}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {allowCustom && (
                <Input
                  placeholder="Or type your answer..."
                  value={customInputs.get(currentIdx) ?? ""}
                  onChange={(e) => {
                    setCustomInputs((prev) => {
                      const next = new Map(prev);
                      next.set(currentIdx, e.target.value);
                      return next;
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isLastQuestion) advanceToNext();
                    if (e.key === "Enter" && isLastQuestion) handleSubmit();
                  }}
                  className="h-8 text-xs"
                />
              )}
            </div>
          )}

          {/* Navigation + actions */}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>
                {currentIdx + 1} / {totalQuestions}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-3 text-xs text-muted-foreground"
                disabled={isPending}
                onClick={handleSkip}
              >
                {rejectMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : null}
                Skip
              </Button>

              {isLastQuestion ? (
                <Button
                  size="sm"
                  className="h-7 px-3 text-xs bg-amber-600 hover:bg-amber-500 text-black font-medium"
                  disabled={isPending}
                  onClick={handleSubmit}
                >
                  {replyMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <Check className="h-3 w-3 mr-1" />
                  )}
                  Submit
                </Button>
              ) : needsNextButton || selected.size > 0 || hasCustomValue ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-3 text-xs"
                  onClick={advanceToNext}
                >
                  Next
                  <ChevronRight className="h-3 w-3 ml-1" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
