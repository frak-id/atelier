import { queryOptions, useMutation } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys, unwrap } from "./keys";

// --- Slack Status ---

export const slackStatusQuery = queryOptions({
  queryKey: queryKeys.slack.status,
  queryFn: async () => unwrap(await api.api.slack.status.get()),
  refetchInterval: 30000,
  refetchIntervalInBackground: false,
});

// --- Slack Config ---

export const slackConfigQuery = queryOptions({
  queryKey: queryKeys.slack.config,
  queryFn: async () => unwrap(await api.api.slack.config.get()),
});

export function useUpdateSlackConfig() {
  return useMutation({
    mutationKey: ["slack", "updateConfig"],
    mutationFn: async (data: {
      botToken: string;
      appToken: string;
      signingSecret: string;
    }) => unwrap(await api.api.slack.config.put(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.slack.all });
    },
  });
}

export function useDeleteSlackConfig() {
  return useMutation({
    mutationKey: ["slack", "deleteConfig"],
    mutationFn: async () => unwrap(await api.api.slack.config.delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.slack.all });
    },
  });
}

// --- Slack Threads ---

export const slackThreadListQuery = queryOptions({
  queryKey: queryKeys.slack.threads,
  queryFn: async () => unwrap(await api.api.slack.threads.get()),
  refetchInterval: 10000,
  refetchIntervalInBackground: false,
});

export function useDeleteSlackThread() {
  return useMutation({
    mutationKey: ["slack", "deleteThread"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.slack.threads({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.slack.threads });
    },
  });
}
