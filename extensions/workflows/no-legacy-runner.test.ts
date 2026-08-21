import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = path.dirname(fileURLToPath(import.meta.url));

function productionSources() {
  return fs
    .readdirSync(directory)
    .filter(
      (name) =>
        (name.endsWith(".ts") || name.endsWith(".cjs")) &&
        !name.endsWith(".test.ts"),
    )
    .map((name) => ({
      name,
      source: fs.readFileSync(path.join(directory, name), "utf8"),
    }));
}

test("legacy workflow child execution path is absent and unreachable", () => {
  assert.equal(fs.existsSync(path.join(directory, "runner.ts")), false);
  assert.equal(fs.existsSync(path.join(directory, "runner.test.ts")), false);
  const combined = productionSources()
    .map(({ name, source }) => `// ${name}\n${source}`)
    .join("\n");
  for (const forbidden of [
    /createAgentSession/,
    /SessionManager\s*\./,
    /createWorkflowResources/,
    /\brunAgent\s*\(/,
    /legacy[^\n]*(?:runner|agent)/i,
    /fallback[^\n]*(?:runner|agent path)/i,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
  assert.match(combined, /manager\.runWorkflowAgent\(/);
});

test("workflow extension factory has only Pi's single ExtensionAPI argument", () => {
  const index = fs.readFileSync(path.join(directory, "index.ts"), "utf8");
  assert.match(index, /export default function workflows\(pi: ExtensionAPI\)/);
  assert.doesNotMatch(index, /observabilitySink\s*:/);
  assert.match(index, /sink: service\.sink/);
});
