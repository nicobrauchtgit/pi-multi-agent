import * as fs from "node:fs";
import * as path from "node:path";
import { READ_LIMITS } from "../constants.mjs";

const ASSET_SPECS = Object.freeze([
  Object.freeze({
    requestPath: "/",
    fileName: "index.html",
    contentType: "text/html; charset=utf-8",
    kind: "document",
  }),
  Object.freeze({
    requestPath: "/app.js",
    fileName: "app.js",
    contentType: "text/javascript; charset=utf-8",
    kind: "asset",
  }),
  Object.freeze({
    requestPath: "/app.css",
    fileName: "app.css",
    contentType: "text/css; charset=utf-8",
    kind: "asset",
  }),
]);

function readStableRegularFile(file, maximumBytes) {
  const before = fs.lstatSync(file);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size > maximumBytes
  ) {
    throw new Error("invalid-static-asset");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("static-asset-changed");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      bytes.length !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error("static-asset-changed");
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function defaultStaticRoot() {
  return path.resolve(import.meta.dirname, "../../ui");
}

/** Load the complete allowlist once. No request path is ever joined to disk. */
export function loadStaticAssets(root = defaultStaticRoot()) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("invalid-static-root");
  }
  const canonicalRoot = fs.realpathSync.native(root);
  const assets = {};
  let totalBytes = 0;
  for (const spec of ASSET_SPECS) {
    const file = path.join(root, spec.fileName);
    const canonicalFile = fs.realpathSync.native(file);
    if (path.dirname(canonicalFile) !== canonicalRoot) {
      throw new Error("static-asset-outside-root");
    }
    const bytes = readStableRegularFile(file, READ_LIMITS.staticAssetBytes);
    totalBytes += bytes.length;
    if (totalBytes > READ_LIMITS.staticTotalBytes) {
      throw new Error("static-assets-too-large");
    }
    assets[spec.requestPath] = Object.freeze({
      body: bytes.toString("utf8"),
      contentLength: bytes.length,
      contentType: spec.contentType,
      kind: spec.kind,
    });
  }
  return Object.freeze(assets);
}

export function staticAssetFor(assets, pathname) {
  return assets && Object.hasOwn(assets, pathname)
    ? assets[pathname]
    : undefined;
}
