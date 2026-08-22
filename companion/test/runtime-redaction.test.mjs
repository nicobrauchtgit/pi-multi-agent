import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import {
  REDACTION_MARKERS,
  redactJson,
  redactString,
} from "../../extensions/shared/redaction.mjs";
import { EXIT } from "../src/constants.mjs";
import { createMetrics } from "../src/metrics.mjs";
import { boundEncodedString } from "../src/ingest/normalize.mjs";
import {
  SQLITE_REEXEC_SENTINEL,
  ensureRuntime,
  isSupportedNodeVersion,
  parseNodeVersion,
} from "../src/runtime.mjs";
import { tempAgentDir } from "./helpers.mjs";

test("runtime floor uses numeric Node tuples", () => {
  assert.deepEqual(parseNodeVersion("22.5.0"), [22, 5, 0]);
  assert.equal(isSupportedNodeVersion("22.4.99"), false);
  assert.equal(isSupportedNodeVersion("22.5.0"), true);
  assert.equal(isSupportedNodeVersion("23.0.0"), true);
});

test("runtime refusal is machine-classifiable and touches no companion home", async (t) => {
  const agentDir = tempAgentDir(t);
  await assert.rejects(
    ensureRuntime({ nodeVersion: "22.4.9", allowReexec: false }),
    (error) =>
      error.code === "runtime-unavailable" &&
      error.exitCode === EXIT.UNAVAILABLE,
  );
  assert.equal(fs.existsSync(`${agentDir}/multi-agent`), false);
});

test("node:sqlite probe re-execs at most once", async () => {
  const calls = [];
  const result = await ensureRuntime({
    nodeVersion: "22.5.0",
    importer: async () => {
      throw new Error("flag required");
    },
    argv: ["daemon.mjs", "status"],
    env: {},
    spawn: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 17, signal: null };
    },
  });
  assert.equal(result.reexec, true);
  assert.equal(result.status, 17);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "--experimental-sqlite");
  assert.equal(calls[0].options.env[SQLITE_REEXEC_SENTINEL], "1");

  await assert.rejects(
    ensureRuntime({
      nodeVersion: "22.5.0",
      importer: async () => {
        throw new Error("still unavailable");
      },
      env: { [SQLITE_REEXEC_SENTINEL]: "1" },
    }),
    (error) => error.exitCode === EXIT.UNAVAILABLE,
  );
  assert.notEqual(EXIT.UNAVAILABLE, EXIT.SOFTWARE);
});

test("shared redaction covers fixed common-secret classes and is idempotent", () => {
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nvery-secret\n-----END PRIVATE KEY-----";
  const source = [
    "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
    "Cookie: session=verysecretvalue",
    "password=hunter2",
    privateKey,
    "npm_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ123456",
    "xoxb-1234567890-abcdefghijklmnop",
    "postgres://dbuser:dbpassword@localhost/database",
  ].join("\n");
  const once = redactString(source);
  const twice = redactString(once.value);
  assert.equal(twice.value, once.value);
  for (const secret of [
    "hunter2",
    "very-secret",
    "dbpassword",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
  ]) {
    assert.equal(once.value.includes(secret), false);
  }
  assert.match(once.value, /\[REDACTED:/);
  assert.ok(
    Object.values(once.counts).reduce((sum, count) => sum + count, 0) >= 5,
  );
});

test("recursive redaction scans keys, unknown values, and secret-named fields", () => {
  const result = redactJson({
    password: "not-in-output",
    nested: [{ note: "Bearer abcdefghijklmnopqrstuvwxyz" }],
    ghp_abcdefghijklmnopqrstuvwxyz123456: "safe",
  });
  const stored = JSON.stringify(result.value);
  assert.equal(stored.includes("not-in-output"), false);
  assert.equal(stored.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.ok(stored.includes(REDACTION_MARKERS.secretField));
  assert.ok(result.counts.secretField > 0);
  assert.ok(result.counts.header > 0);
  assert.ok(result.counts.token > 0);
});

test("metrics reject reasons are sanitized and cardinality bounded at increment time", (t) => {
  const agentDir = tempAgentDir(t);
  const file = `${agentDir}/metrics.json`;
  const metrics = createMetrics(file);
  for (let index = 0; index < 300; index++) {
    metrics.reject(
      index % 2 === 0 ? `reason-${index}` : `invalid reason/${index}`,
    );
  }
  assert.ok(Object.keys(metrics.state.rejectedByReason).length <= 128);
  assert.equal(Object.hasOwn(metrics.state.rejectedByReason, "invalid"), true);
  assert.equal(Object.hasOwn(metrics.state.rejectedByReason, "other"), true);
});

test("redaction rules stay bounded on adversarial input", () => {
  const input = `${"a".repeat(2 * 1024 * 1024)}-----BEGIN PRIVATE KEY-----${"b".repeat(1024)}`;
  const started = performance.now();
  redactString(input);
  assert.ok(performance.now() - started < 1_500);
});

test("marker-dense truncation work is bounded by fixed redaction classes", () => {
  const label = (value) => {
    let result = "";
    do {
      result = String.fromCharCode(97 + (value % 26)) + result;
      value = Math.floor(value / 26);
    } while (value > 0);
    return result;
  };
  const chunks = [];
  let bytes = 0;
  for (let index = 0; bytes < 2 * 1024 * 1024; index++) {
    const marker = `[REDACTED:${label(index)}]`;
    chunks.push(marker);
    bytes += marker.length;
  }
  const dense = chunks.join("");
  const plain = "x".repeat(dense.length);
  const plainStarted = performance.now();
  boundEncodedString(plain, 64 * 1024);
  const plainMs = performance.now() - plainStarted;
  const denseStarted = performance.now();
  boundEncodedString(dense, 64 * 1024);
  const denseMs = performance.now() - denseStarted;
  assert.ok(denseMs < Math.max(750, plainMs * 10), { denseMs, plainMs });
});
