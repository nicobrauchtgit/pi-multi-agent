import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { truncateUtf8 } from "../../../shared/text.ts";
import type { HandoffDocument } from "./schema.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
const promptRoot = path.resolve(directory, "../../prompts/handoff");

function readPrompt(name: string) {
  return fs.readFileSync(path.join(promptRoot, name), "utf8");
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(
    /\{\{([a-zA-Z0-9_]+)\}\}/g,
    (_match, key) => values[key] ?? "",
  );
}

export function formatHandoffDocument(doc: HandoffDocument): string {
  const lines = [
    `Summary: ${doc.summary}`,
    `Current state: ${doc.currentState}`,
    `Files touched: ${doc.filesTouched.length ? doc.filesTouched.join(", ") : "none recorded"}`,
    `Checks run: ${doc.checksRun.length ? doc.checksRun.join(", ") : "none recorded"}`,
    `Open issues: ${doc.openIssues.length ? doc.openIssues.join("; ") : "none recorded"}`,
    `Next steps: ${doc.nextSteps.length ? doc.nextSteps.join("; ") : "continue the original task"}`,
    `Risks: ${doc.risks.length ? doc.risks.join("; ") : "none recorded"}`,
  ];
  return truncateUtf8(lines.join("\n"), 12 * 1024);
}

export function buildContinuationPrompt(options: {
  readonly originalPrompt: string;
  readonly nextPrompt: string;
  readonly handoff: HandoffDocument;
}) {
  return fill(readPrompt("continuation.prompt.md"), {
    originalPrompt: truncateUtf8(options.originalPrompt, 16 * 1024),
    nextPrompt: truncateUtf8(options.nextPrompt, 16 * 1024),
    handoff: formatHandoffDocument(options.handoff),
  });
}

export function handoffSummaryInstructions() {
  return readPrompt("summary.prompt.md");
}
