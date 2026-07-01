import { useCallback, useState } from "react";
import { toast } from "sonner";
import { isInterventionExpired } from "@/api/agent";
import {
  useRejectQuestion,
  useReplyPermission,
  useReplyQuestion,
} from "@/api/queries/agent";

/**
 * Shared permission/question reply logic (mutation + toast + expiry handling),
 * used by both AttentionBlock and ExpandableInterventions so the intervention
 * wiring lives in one place and the two components only differ in presentation.
 */
export function usePermissionAction(sandboxId: string) {
  const mutation = useReplyPermission(sandboxId);
  const [clickedAction, setClickedAction] = useState<"once" | "reject" | null>(
    null,
  );

  const reply = useCallback(
    (requestId: string, decision: "once" | "reject") => {
      setClickedAction(decision);
      mutation.mutate(
        { requestID: requestId, reply: decision },
        {
          onSuccess: () =>
            toast.success(
              decision === "once" ? "Permission approved" : "Permission denied",
            ),
          onError: (error) => {
            setClickedAction(null);
            toast.error(
              isInterventionExpired(error)
                ? "Permission request expired"
                : "Failed to reply to permission",
            );
          },
        },
      );
    },
    [mutation],
  );

  return { reply, isPending: mutation.isPending, clickedAction };
}

export function useQuestionAction(sandboxId: string) {
  const replyMutation = useReplyQuestion(sandboxId);
  const rejectMutation = useRejectQuestion(sandboxId);

  const submit = useCallback(
    (requestId: string, answers: string[][]) => {
      replyMutation.mutate(
        { requestID: requestId, answers },
        {
          onSuccess: () => toast.success("Answer submitted"),
          onError: (error) =>
            toast.error(
              isInterventionExpired(error)
                ? "Question expired"
                : "Failed to submit answer",
            ),
        },
      );
    },
    [replyMutation],
  );

  const skip = useCallback(
    (requestId: string) => {
      rejectMutation.mutate(requestId, {
        onSuccess: () => toast.success("Question skipped"),
        onError: (error) =>
          toast.error(
            isInterventionExpired(error)
              ? "Question expired"
              : "Failed to skip question",
          ),
      });
    },
    [rejectMutation],
  );

  return {
    submit,
    skip,
    isReplyPending: replyMutation.isPending,
    isRejectPending: rejectMutation.isPending,
    isPending: replyMutation.isPending || rejectMutation.isPending,
  };
}
