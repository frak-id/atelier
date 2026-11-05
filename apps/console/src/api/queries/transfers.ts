import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

export const TRANSFER_KINDS = ["secrets", "toolboxes"] as const;
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
 * `from` and `to` are org ids (the source is usually the caller's personal
 * org). Only fetched once both are chosen (see `enabled` at the call site).
 */
export function transferPreviewQuery(from: string, to: string) {
  return queryOptions({
    queryKey: queryKeys.transfers.preview(from, to),
    queryFn: async () => {
      return unwrap(
        await api.api.transfers.preview.get({
          query: { from, to },
        }),
        "Failed to load the preview",
      ) as TransferPreview;
    },
    enabled: from.length > 0 && to.length > 0,
  });
}

const KIND_NOUN: Record<TransferKind, [string, string]> = {
  secrets: ["secret", "secrets"],
  toolboxes: ["toolbox", "toolboxes"],
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
      return unwrap(await api.api.transfers.post(body), "Failed to move");
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.toolboxes.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.toolsets.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.transfers.all });
      toast.success(result ? summarize(result.moved) : "Moved");
    },
    onError: (error) => toast.error(error.message),
  });
}
