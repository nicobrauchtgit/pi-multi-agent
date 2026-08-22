import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  advanceCursor,
  classifyContent,
  consumeBootstrapToken,
  nextBackoff,
  parseBootstrapToken,
  renderRow,
} from "../ui/app.js";

const uiRoot = path.resolve(import.meta.dirname, "../ui");

class NodeShim {
  constructor(tag) {
    this.tag = tag;
    this.className = "";
    this.textContent = "";
    this.children = [];
  }

  append(...nodes) {
    this.children.push(...nodes);
  }
}

const documentShim = {
  createElement(tag) {
    return new NodeShim(tag);
  },
};

function flatten(node) {
  return [node, ...node.children.flatMap(flatten)];
}

test("fragment bootstrap accepts only one base64url capability and immediately replaces history", () => {
  const token = "A".repeat(42) + "_";
  assert.equal(parseBootstrapToken(`#${token}`), token);
  assert.equal(parseBootstrapToken(token), token);
  for (const invalid of [
    "",
    "#",
    "#short",
    `#${"a".repeat(42)}`,
    `#${"a".repeat(44)}`,
    `#${"a".repeat(42)}%2F`,
    `#${"a".repeat(42)}+`,
    `#${"a".repeat(42)}/`,
  ]) {
    assert.equal(parseBootstrapToken(invalid), null, invalid);
  }

  const calls = [];
  assert.equal(
    consumeBootstrapToken(
      { hash: `#${token}` },
      { replaceState: (...args) => calls.push(args) },
    ),
    token,
  );
  assert.deepEqual(calls, [[null, "", "/"]]);
  const missingCalls = [];
  assert.equal(
    consumeBootstrapToken(
      { hash: "" },
      { replaceState: (...args) => missingCalls.push(args) },
    ),
    null,
  );
  assert.deepEqual(missingCalls, []);
});

test("cursor advancement and polling backoff preserve scoped sequence semantics", () => {
  assert.equal(
    advanceCursor(4, {
      events: [{ seq: 7 }, { seq: 5 }, { seq: 6 }],
      currentSeq: 99,
      hasMore: true,
    }),
    7,
  );
  assert.equal(
    advanceCursor(7, { events: [], currentSeq: 20, hasMore: false }),
    20,
  );
  assert.equal(
    advanceCursor(7, { events: [], currentSeq: 20, hasMore: true }),
    7,
  );
  assert.equal(
    advanceCursor(1009, { events: [], currentSeq: 20, hasMore: false }),
    1009,
  );
  assert.equal(
    advanceCursor(1009, {
      events: [{ seq: 20 }, { seq: 100 }],
      currentSeq: 100,
      hasMore: false,
    }),
    1009,
  );
  assert.equal(nextBackoff(2_000), 4_000);
  assert.equal(nextBackoff(16_000), 30_000);
  assert.equal(nextBackoff(30_000), 30_000);
  assert.equal(nextBackoff(30_000, true), 2_000);
});

test("content badges honestly distinguish metadata, redaction, truncation, omission, unavailable, and recovery", () => {
  assert.deepEqual(
    classifyContent({
      kind: "artifact.recovered",
      payload: { resultUnavailable: true },
      capture: { contentMode: "metadata", truncated: true },
      redaction: { counts: { token: 2 } },
    }),
    ["metadata-only", "redacted", "truncated", "omitted", "recovered"],
  );
  assert.deepEqual(
    classifyContent({
      kind: "agent.message",
      payload: null,
      capture: { contentMode: "metadata", unavailable: true },
      redaction: null,
    }),
    ["metadata-only", "unavailable"],
  );
});

test("stored XSS fixtures are assigned only as inert text in pure row rendering", () => {
  const fixture =
    '<img src=x onerror="globalThis.pwned=true"></script>javascript:';
  const row = renderRow(documentShim, {
    title: fixture,
    meta: "\u202eexe.js",
    badges: ["redacted"],
    summary: fixture,
    content: fixture,
  });
  const nodes = flatten(row);
  assert.ok(nodes.some((node) => node.textContent === fixture));
  assert.equal(
    nodes.some((node) => node.tag === "img" || node.tag === "script"),
    false,
  );
  assert.equal(
    nodes.some((node) => node.src || node.href),
    false,
  );
});

test("static UI has no executable inline content, injection sinks, persistent token stores, or remote resources", () => {
  const javascript = fs.readFileSync(path.join(uiRoot, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
  for (const forbidden of [
    "inner" + "HTML",
    "outer" + "HTML",
    "insertAdjacent" + "HTML",
    "document." + "write",
    "new " + "Function",
    "src" + "doc",
    "local" + "Storage",
    "session" + "Storage",
    "document." + "cookie",
    "window." + "name",
  ]) {
    assert.equal(javascript.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(javascript, /\beval\s*\(/);
  assert.match(javascript, /Authorization: `Bearer \$\{readCapability\}`/);
  assert.match(javascript, /credentials: "omit"/);
  assert.match(javascript, /cache: "no-store"/);
  assert.match(javascript, /redirect: "error"/);
  assert.match(javascript, /referrerPolicy: "no-referrer"/);
  assert.equal((javascript.match(/replaceState/g) ?? []).length, 1);
  assert.equal(javascript.includes("pushState"), false);
  assert.equal(javascript.includes("console."), false);
  assert.match(javascript, /stale snapshot/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});
