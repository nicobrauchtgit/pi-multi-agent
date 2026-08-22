import assert from "node:assert/strict";
import test from "node:test";
import { REDACTION_MARKERS, redactJson, redactString } from "./redaction.mjs";

test("TypeScript/Pi context imports the same bare-Node redaction module", () => {
  const fixture = {
    authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
    cookieLine: "Cookie: session=secret-session-value",
    nested: { api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" },
  };
  const redacted = redactJson(fixture);
  const stored = JSON.stringify(redacted.value);
  assert.equal(stored.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(stored.includes("secret-session-value"), false);
  assert.equal(
    stored.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"),
    false,
  );
  assert.equal(redactString(stored).value, stored);
});

test("marker-bearing matches redact real secrets without breaking idempotency", () => {
  const secrets = [
    "SEEDCANARY_AAA_11111",
    "SEEDCANARY_BBB_22222",
    "SEEDCANARY_CCC_33333",
    "SEEDCANARY_DDD_44444",
  ];
  const source = [
    `Authorization: ${secrets[0]} [REDACTED:header]`,
    `Cookie: SESSION=${secrets[1]} [REDACTED:cookie]`,
    `password=${secrets[2]}[REDACTED:x]`,
    `postgres://user:${secrets[3]}[REDACTED:x]@localhost/db`,
  ].join("\n");
  const once = redactString(source);
  const twice = redactString(once.value);
  assert.equal(twice.value, once.value);
  assert.equal(
    Object.values(twice.counts).reduce((sum, count) => sum + count, 0),
    0,
  );
  for (const secret of secrets)
    assert.equal(once.value.includes(secret), false);
  assert.ok(once.counts.header > 0);
  assert.ok(once.counts.cookie > 0);
  assert.ok(once.counts.secretField > 0);
  assert.ok(once.counts.credentialUrl > 0);
});

test("JSON token boundaries are out-of-band and cannot peel attacker sentinels", () => {
  const oldSentinel = "\r\u0000redaction-json-boundary\u0000";
  const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX";
  const fixtures = [
    `${oldSentinel}${secret}${oldSentinel}`,
    JSON.stringify({
      modelLabel: `${oldSentinel}${oldSentinel}${secret}${oldSentinel}`,
    }),
    JSON.stringify(
      JSON.stringify(`${oldSentinel}${oldSentinel}${secret}${oldSentinel}`),
    ),
  ];
  for (const fixture of fixtures) {
    let current = fixture;
    for (let pass = 0; pass < 6; pass++) {
      current = redactString(current).value;
      assert.equal(
        current.includes(secret),
        false,
        `secret survived fixture ${fixtures.indexOf(fixture)} pass ${pass}`,
      );
    }
  }
});

test("netrc-style whitespace assignments are redacted", () => {
  const source = "machine example.test login user password mypassword123";
  const redacted = redactString(source);
  assert.equal(redacted.value.includes("mypassword123"), false);
  assert.match(redacted.value, /password \[REDACTED:secret-field\]/);
});

test("secret-named JSON fields replace their complete subtree", () => {
  const secrets = ["SEEDCANARY_ARRAY_11111", "SEEDCANARY_OBJECT_22222"];
  const once = redactJson({
    password: [secrets[0]],
    token: { raw: secrets[1] },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(once.value)), {
    password: REDACTION_MARKERS.secretField,
    token: REDACTION_MARKERS.secretField,
  });
  assert.equal(once.counts.secretField, 2);
  const stored = JSON.stringify(once.value);
  for (const secret of secrets) assert.equal(stored.includes(secret), false);
  const twice = redactJson(once.value);
  assert.equal(JSON.stringify(twice.value), stored);
  assert.equal(twice.counts.secretField, 0);
});

test("common authorization and token key variants suppress values", () => {
  const secret = "Basic U0VFRENBTkFSWV9LRVlfVkFSSUFOVF8xMTExMQ==";
  const keys = [
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
    "accessToken",
    "refresh_token",
    "id-token",
    "session_token",
    "auth_token",
    "bearer",
    "credential",
    "credentials",
  ];
  const source = Object.fromEntries(
    keys.map((key, index) => [
      key,
      index % 3 === 0 ? [secret] : index % 3 === 1 ? { raw: secret } : secret,
    ]),
  );
  const redacted = redactJson(source);
  const stored = JSON.stringify(redacted.value);
  assert.equal(stored.includes(secret), false);
  for (const key of keys) {
    assert.equal(
      (redacted.value as Record<string, unknown>)[key],
      REDACTION_MARKERS.secretField,
    );
  }
});

test("companion contains no copied redaction implementation", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dirname, "../../companion");
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(file);
    }
  }
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.equal(
      /function\s+redactString|const\s+GITHUB_TOKEN/.test(source),
      false,
      `copied redaction implementation in ${file}`,
    );
  }
});

test("production extensions never import bare companion internals", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dirname, "..");
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") pending.push(file);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        const source = await readFile(file, "utf8");
        assert.equal(
          /(?:from\s+|import\s*\()["'][^"']*companion\//.test(source),
          false,
          `production extension imports companion code: ${file}`,
        );
      }
    }
  }
});
