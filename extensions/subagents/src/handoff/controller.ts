import type { HandoffDocument } from "./schema.ts";

const MAX_TEXT = 12 * 1024;
const MAX_ITEMS = 20;

function clip(value: string, max = MAX_TEXT) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function pushBounded(values: string[], value: string | undefined) {
  const text = value?.trim();
  if (!text) return;
  values.push(clip(text, 1024));
  if (values.length > MAX_ITEMS) values.splice(0, values.length - MAX_ITEMS);
}

export interface HandoffRecorderEvent {
  readonly kind:
    "user" | "assistant" | "tool" | "error" | "final" | "usage" | "meta";
  readonly text?: string;
  readonly name?: string;
  readonly isError?: boolean;
  readonly tokens?: number;
  readonly contextWindow?: number;
}

export function handoffDocumentFromAgentText(
  text: string,
  fallback: HandoffDocument,
): HandoffDocument {
  const summary = clip(text.trim() || fallback.summary, 2048);
  return {
    ...fallback,
    summary,
    currentState: summary,
  };
}

export function createHandoffRecorder(originalPrompt: string) {
  const users: string[] = [];
  const assistants: string[] = [];
  const tools: string[] = [];
  const errors: string[] = [];
  let finalText = "";
  let tokens: number | undefined;
  let contextWindow: number | undefined;

  return {
    record(event: HandoffRecorderEvent) {
      switch (event.kind) {
        case "user":
          pushBounded(users, event.text);
          break;
        case "assistant":
          pushBounded(assistants, event.text);
          break;
        case "tool":
          pushBounded(
            tools,
            `${event.name ?? "tool"}${event.isError ? " failed" : ""}${
              event.text ? `: ${event.text}` : ""
            }`,
          );
          break;
        case "error":
          pushBounded(errors, event.text);
          break;
        case "final":
          finalText = clip(event.text ?? "");
          break;
        case "usage":
          tokens = event.tokens;
          contextWindow = event.contextWindow;
          break;
        case "meta":
          break;
      }
    },
    document(reason: string): HandoffDocument {
      return {
        summary: clip(
          finalText || assistants.at(-1) || `Continue after ${reason}`,
          2048,
        ),
        currentState: clip(
          [
            `Reason: ${reason}`,
            tokens !== undefined
              ? `Context usage: ${tokens}${contextWindow ? `/${contextWindow}` : ""} tokens`
              : undefined,
            `Task: ${clip(originalPrompt, 2048)}`,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        filesTouched: [],
        checksRun: tools.filter((tool) =>
          /test|check|lint|tsc|npm|pnpm|yarn/i.test(tool),
        ),
        openIssues: errors,
        nextSteps: [
          "Continue the latest requested work from the carried state.",
        ],
        risks: [],
      };
    },
  };
}
