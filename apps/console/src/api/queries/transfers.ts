import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export const TRANSFER_KINDS = [
  "secrets",
  "policy",
  "toolboxes",
  "starters",
] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

export interface TransferItem {
  id: string;
  label: string;
  blocker?: string;
  notes: string[];
}

type TransferPreview = Record<TransferKind, TransferItem[]>;
export type TransferSelection = Record<TransferKind, string[]>;

/**
 * `from` is `user` (the caller's personal scope) or `org:<id>`; `to` is a
 * destination org id. Only fetched once both are chosen (see `enabled` at
 * the call site).
 */
export function transferPreviewQuery(from: string, to: string) {
  return queryOptions({
    queryKey: queryKeys.transfers.preview(from, to),
    queryFn: async () => {
      const { data, error } = await api.api.transfers.preview.get({
        query: { from, to },
      });
      if (error)
        throw new Error(errorMessage(error, "Failed to load the preview"));
      return data as TransferPreview;
    },
    enabled: from.length > 0 && to.length > 0,
  });
}

const KIND_NOUN: Record<TransferKind, [string, string]> = {
  secrets: ["secret", "secrets"],
  policy: ["org policy", "org policies"],
  toolboxes: ["toolbox", "toolboxes"],
  starters: ["starter", "starters"],
};

function summarize(moved: Record<TransferKind, number>): string {
  const parts = TRANSFER_KINDS.filter((kind) => moved[kind] > 0).map((kind) => {
    const count = moved[kind];
    const [one, many] = KIND_NOUN[kind];
    return `${count} ${count === 1 ? one : many}`;
  });
  return parts.length > 0 ? `Moved ${parts.join(", ")}` : "Nothing moved";
}

export function useMoveResources() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      from: string;
      to: string;
      selection: TransferSelection;
    }) => {
      const { data, error } = await api.api.transfers.post(body);
      if (error) throw new Error(errorMessage(error, "Failed to move"));
      return data;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.orgPolicy.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.toolboxes.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.launchpad.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.toolsets.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.transfers.all });
      const message = result ? summarize(result.moved) : "Moved";
      const suffix =
        result && result.rewrittenStarters > 0
          ? ` (${result.rewrittenStarters} starter${
              result.rewrittenStarters === 1 ? "" : "s"
            } repointed)`
          : "";
      toast.success(`${message}${suffix}`);
    },
    onError: (error) => toast.error(error.message),
  });
}
