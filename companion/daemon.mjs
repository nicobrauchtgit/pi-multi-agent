#!/usr/bin/env node
import { EXIT } from "./src/constants.mjs";
import { ensureRuntime } from "./src/runtime.mjs";

async function main() {
  process.umask(0o077);
  const runtime = await ensureRuntime();
  if (runtime.reexec) {
    process.exitCode = runtime.status;
    return;
  }
  const { runCli } = await import("./src/cli.mjs");
  await runCli(process.argv.slice(2));
}

try {
  await main();
} catch (error) {
  const code =
    error && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : "daemon-failed";
  const exitCode =
    error && typeof error === "object" && Number.isInteger(error.exitCode)
      ? error.exitCode
      : EXIT.SOFTWARE;
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: code, exitCode })}\n`,
  );
  process.exitCode = exitCode;
}
