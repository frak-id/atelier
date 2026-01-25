import type { QuestionRequest } from "@opencode-ai/sdk/v2";

export function getQuestionDisplayText(question: QuestionRequest): string {
  return (
    question.questions[0]?.header ??
    question.questions[0]?.question ??
    "Question"
  );
}

export function formatSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export const INTERVENTION_STYLES = {
  permission: {
    badge:
      "bg-purple-100 dark:bg-purple-950 border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300",
  },
  question: {
    badge:
      "bg-cyan-100 dark:bg-cyan-950 border-cyan-300 dark:border-cyan-700 text-cyan-700 dark:text-cyan-300",
  },
} as const;
