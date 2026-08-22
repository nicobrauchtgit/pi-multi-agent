import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OBSERVABILITY_LIMITS,
  normalizeProducerEnvelope,
} from "./observability/normalize.mjs";
import {
  classifyContentPath,
  normalizePolicyConfig,
  resolveProjectPolicy,
} from "./observability/policy.mjs";

function envelope(payload: Record<string, unknown>, mode = "rich") {
  return {
    v: 1,
    eventId: "event_00000000-0000-4000-8000-000000000001",
    kind: "message.assistant",
    schemaVersion: 1,
    producer: {
      id: "producer_00000000-0000-4000-8000-000000000001",
      seq: 1,
      kind: "pi",
    },
    occurredAt: 1,
    ids: { runId: "pi-run:test" },
    project: { id: "untrusted", root: "/tmp/project" },
    payload,
    capture: { contentMode: mode, truncated: false },
  };
}

test("shared producer normalization redacts, bounds, and fully re-scans before disk", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const normalized = normalizeProducerEnvelope(
    envelope({
      content: `${"😀".repeat(80_000)} Authorization: Bearer ${secret}`,
      nested: { password: { raw: secret } },
    }),
  );

  assert.ok(normalized.bytes <= OBSERVABILITY_LIMITS.storedEventBytes);
  assert.equal(normalized.serialized.includes(secret), false);
  assert.match(normalized.serialized, /REDACTED/);
  assert.equal(normalized.serialized.includes("�"), false);
  assert.equal(normalized.event.capture.truncated, true);
  assert.ok(
    (normalized.event.capture.truncatedFields ?? []).includes(
      "payload.content",
    ),
  );

  const rescanned = normalizeProducerEnvelope(normalized.event, {
    contentMode: "rich",
  });
  assert.deepEqual(rescanned.event.payload, normalized.event.payload);
});

test("metadata-surviving fields cannot reassemble secrets across redaction passes", () => {
  const oldSentinel = "\r\u0000redaction-json-boundary\u0000";
  const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX";
  let current = normalizeProducerEnvelope(
    envelope(
      {
        modelLabel: `${oldSentinel}${oldSentinel}${secret}${oldSentinel}`,
      },
      "metadata",
    ),
    { contentMode: "metadata" },
  ).event;
  for (let pass = 0; pass < 5; pass++) {
    const normalized = normalizeProducerEnvelope(current, {
      contentMode: "metadata",
    });
    assert.equal(
      normalized.serialized.includes(secret),
      false,
      `secret survived normalization pass ${pass}`,
    );
    current = normalized.event;
  }
});

test("metadata producer policy omits additive content rather than storing a preview", () => {
  const normalized = normalizeProducerEnvelope(
    envelope({ content: "private prompt", model: "provider/model" }, "rich"),
    { contentMode: "metadata" },
  );
  assert.deepEqual(Object.keys(normalized.event.payload), ["model"]);
  assert.equal(normalized.event.payload.model, "provider/model");
  assert.equal(normalized.event.capture.contentMode, "metadata");
  assert.equal(normalized.serialized.includes("private prompt"), false);
});

test("patch and diff bytes are reference-only even in rich normalization", () => {
  const normalized = normalizeProducerEnvelope(
    envelope(
      {
        patch: "@@ -1 +1 @@\n-secret\n+replacement",
        diffText: "complete-diff-bytes",
        model: "provider/model",
      },
      "rich",
    ),
    { contentMode: "rich" },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.event.payload)), {
    model: "provider/model",
  });
  assert.equal(normalized.serialized.includes("complete-diff-bytes"), false);
  assert.equal(normalized.event.capture.truncated, true);
  assert.deepEqual(normalized.event.capture.truncatedFields, [
    "payload.diffText",
    "payload.patch",
  ]);
});

test("declared thinking metadata is retained without a false truncation", () => {
  const normalized = normalizeProducerEnvelope(
    envelope({ thinkingLevel: "off", thinkingPartCount: 0 }, "metadata"),
    { contentMode: "metadata" },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.event.payload)), {
    thinkingLevel: "off",
    thinkingPartCount: 0,
  });
  assert.equal(normalized.event.capture.truncated, false);
  assert.equal(normalized.event.capture.truncatedFields, undefined);
});

test("longest canonical project root wins and producer can only narrow policy", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-policy-d2-"));
  const nested = path.join(directory, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });
  const linked = `${directory}-link`;
  fs.symlinkSync(directory, linked, "dir");
  t.after(() => {
    fs.rmSync(linked, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const config = normalizePolicyConfig({
    version: 1,
    capture: "rich",
    defaults: { enabled: true, contentMode: "metadata" },
    projects: [
      { root: directory, enabled: false },
      { root: nested, enabled: true, contentMode: "rich" },
    ],
  });
  const selected = resolveProjectPolicy(
    config,
    path.join(linked, "packages", "app"),
  );
  assert.equal(selected.enabled, true);
  assert.equal(selected.contentMode, "rich");
  assert.equal(selected.policySource, "project");
  assert.equal(
    resolveProjectPolicy(config, path.join(directory, "packages", "other"))
      .enabled,
    false,
  );
  const unattributed = resolveProjectPolicy(config, undefined);
  assert.equal(unattributed.enabled, true);
  assert.equal(unattributed.contentMode, "metadata");
  assert.equal(unattributed.policySource, "unattributed");
});

test("secret-path classification covers project defaults, companion, and Moshi roots", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-secret-path-d2-"),
  );
  const project = path.join(directory, "project");
  const companion = path.join(directory, "observability");
  const moshi = path.join(directory, "moshi", "sessions");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(companion, { recursive: true });
  fs.mkdirSync(moshi, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(
    classifyContentPath({
      value: ".env.local",
      cwd: project,
      projectRoot: project,
      excludePaths: [".env*"],
    }).classification,
    "secret-path",
  );
  assert.equal(
    classifyContentPath({
      value: path.join(companion, "ingest.token"),
      projectRoot: project,
      protectedRoots: [companion],
    }).classification,
    "protected",
  );
  assert.equal(
    classifyContentPath({
      value: path.join(moshi, "session.json"),
      projectRoot: project,
      moshiPaths: [moshi],
    }).classification,
    "protected",
  );
});

test("companion imports the shared normalization pipeline instead of copying it", () => {
  const current = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(current, "../../companion/src/ingest/normalize.mjs"),
    "utf8",
  );
  assert.match(source, /shared\/observability\/normalize\.mjs/);
  assert.doesNotMatch(source, /function normalizePayload\s*\(/);
  assert.doesNotMatch(source, /function boundEncodedString\s*\(/);
});
