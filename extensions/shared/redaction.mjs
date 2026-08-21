import { Buffer } from "node:buffer";

export const REDACTION_RULES_VERSION = 1;
export const REDACTION_MARKERS = Object.freeze({
  header: "[REDACTED:header]",
  cookie: "[REDACTED:cookie]",
  secretField: "[REDACTED:secret-field]",
  privateKey: "[REDACTED:private-key]",
  token: "[REDACTED:token]",
  credentialUrl: "[REDACTED:credential-url]",
});

const EXACT_MARKER = /^\[REDACTED:[a-z-]+\]$/;
const SECRET_KEY =
  /^(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|aws[_-]?(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?id)|auth(?:orization)?|cookie|set-cookie)$/i;
const HEADER = /\b(authorization|proxy-authorization)(\s*:\s*)([^\r\n]*)/gi;
const COOKIE = /\b(set-cookie|cookie)(\s*:\s*)([^\r\n]*)/gi;
const BEARER = /\bbearer[ \t]+[A-Za-z0-9._~+\/-]{8,4096}/gi;
const SECRET_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|aws[_-]?(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?id))\b([ \t]*[:=][ \t]*)("[^"\r\n]{0,4096}"|'[^'\r\n]{0,4096}'|[^\s,;\r\n]{1,4096})/gi;
const GITHUB_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{36,255}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g;
const OPENAI_TOKEN = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}\b/g;
const JWT =
  /\beyJ[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,2048}\b/g;
const CREDENTIAL_URL =
  /\b([A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/)([^\s\/@]{1,769})@/g;
const JSON_STRING_BOUNDARY = "\r\u0000redaction-json-boundary\u0000";

/** @returns {Record<string, number>} */
export function emptyRedactionCounts() {
  return {
    header: 0,
    cookie: 0,
    secretField: 0,
    privateKey: 0,
    token: 0,
    credentialUrl: 0,
  };
}

/**
 * @param {Record<string, number>} target
 * @param {Record<string, number>} source
 */
export function mergeRedactionCounts(target, source) {
  for (const [rule, count] of Object.entries(source)) {
    target[rule] = (target[rule] ?? 0) + count;
  }
  return target;
}

/**
 * Replace without exposing the match or its exact length to callers.
 * @param {string} value
 * @param {RegExp} pattern
 * @param {string} marker
 * @param {Record<string, number>} counts
 * @param {string} rule
 */
function replaceCounted(value, pattern, marker, counts, rule) {
  return value.replace(pattern, () => {
    counts[rule] = (counts[rule] ?? 0) + 1;
    return marker;
  });
}

/** @param {string} value */
function isExactMarker(value) {
  const trimmed = value.trim();
  const unquoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;
  return EXACT_MARKER.test(unquoted);
}

function replaceNamedSecret(value, pattern, marker, counts, rule) {
  return value.replace(pattern, (match, name, separator, secret) => {
    if (isExactMarker(secret)) return match;
    counts[rule] = (counts[rule] ?? 0) + 1;
    return `${name}${separator}${marker}`;
  });
}

function boundJsonStrings(input) {
  try {
    JSON.parse(input);
  } catch {
    return input;
  }
  let output = "";
  let inString = false;
  let escaped = false;
  for (const character of input) {
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      output += character;
      escaped = true;
    } else if (character === '"') {
      output += `${JSON_STRING_BOUNDARY}${character}`;
      inString = false;
    } else {
      output += character;
    }
  }
  return output;
}

/**
 * PEM scanning is index-based so an unterminated block cannot cause regex
 * backtracking over a large payload.
 * @param {string} input
 * @param {Record<string, number>} counts
 */
function redactPrivateKeys(input, counts) {
  const beginPrefix = "-----BEGIN ";
  const privateSuffix = "PRIVATE KEY-----";
  let cursor = 0;
  let output = "";
  while (cursor < input.length) {
    const begin = input.indexOf(beginPrefix, cursor);
    if (begin < 0) {
      output += input.slice(cursor);
      break;
    }
    const headerEnd = input.indexOf(privateSuffix, begin + beginPrefix.length);
    if (headerEnd < 0 || headerEnd - begin > 96) {
      output += input.slice(cursor, begin + beginPrefix.length);
      cursor = begin + beginPrefix.length;
      continue;
    }
    const label = input.slice(begin + beginPrefix.length, headerEnd);
    const endMarker = `-----END ${label}${privateSuffix}`;
    const end = input.indexOf(endMarker, headerEnd + privateSuffix.length);
    output += input.slice(cursor, begin);
    output += REDACTION_MARKERS.privateKey;
    counts.privateKey = (counts.privateKey ?? 0) + 1;
    cursor = end < 0 ? input.length : end + endMarker.length;
  }
  return output;
}

/**
 * Apply the fixed common-secret rules to one complete string.
 * @param {string} input
 * @returns {{ value: string, counts: Record<string, number> }}
 */
export function redactString(input) {
  const counts = emptyRedactionCounts();
  if (input.length === 0) return { value: input, counts };

  let value = redactPrivateKeys(boundJsonStrings(input), counts);
  value = replaceNamedSecret(
    value,
    HEADER,
    REDACTION_MARKERS.header,
    counts,
    "header",
  );
  value = replaceNamedSecret(
    value,
    COOKIE,
    REDACTION_MARKERS.cookie,
    counts,
    "cookie",
  );
  value = replaceCounted(
    value,
    BEARER,
    "Bearer [REDACTED:header]",
    counts,
    "header",
  );
  value = replaceNamedSecret(
    value,
    SECRET_ASSIGNMENT,
    REDACTION_MARKERS.secretField,
    counts,
    "secretField",
  );
  value = replaceCounted(
    value,
    GITHUB_TOKEN,
    REDACTION_MARKERS.token,
    counts,
    "token",
  );
  value = replaceCounted(
    value,
    AWS_ACCESS_KEY,
    REDACTION_MARKERS.token,
    counts,
    "token",
  );
  value = replaceCounted(
    value,
    NPM_TOKEN,
    REDACTION_MARKERS.token,
    counts,
    "token",
  );
  value = replaceCounted(
    value,
    SLACK_TOKEN,
    REDACTION_MARKERS.token,
    counts,
    "token",
  );
  value = replaceCounted(
    value,
    OPENAI_TOKEN,
    REDACTION_MARKERS.token,
    counts,
    "token",
  );
  value = replaceCounted(value, JWT, REDACTION_MARKERS.token, counts, "token");
  value = value.replace(CREDENTIAL_URL, (match, scheme, credentials) => {
    if (isExactMarker(credentials)) return match;
    counts.credentialUrl = (counts.credentialUrl ?? 0) + 1;
    return `${scheme}${REDACTION_MARKERS.credentialUrl}@`;
  });
  return { value: value.replaceAll(JSON_STRING_BOUNDARY, ""), counts };
}

/** @param {string} key */
export function isSecretFieldName(key) {
  return SECRET_KEY.test(key);
}

/**
 * Recursively redact every JSON key and string. Objects are rebuilt without
 * prototypes and keys are sorted so the persisted representation is stable.
 * A post-redaction key collision is rejected instead of dropping data.
 *
 * @param {unknown} input
 * @param {{ secretNamedValues?: boolean }} [options]
 * @returns {{ value: unknown, counts: Record<string, number> }}
 */
export function redactJson(input, options = {}) {
  const counts = emptyRedactionCounts();
  const secretNamedValues = options.secretNamedValues !== false;

  /** @param {unknown} value @param {string | undefined} parentKey */
  const visit = (value, parentKey) => {
    if (secretNamedValues && parentKey && isSecretFieldName(parentKey)) {
      if (value === REDACTION_MARKERS.secretField) return value;
      counts.secretField++;
      return REDACTION_MARKERS.secretField;
    }
    if (typeof value === "string") {
      const redacted = redactString(value);
      mergeRedactionCounts(counts, redacted.counts);
      return redacted.value;
    }
    if (Array.isArray(value))
      return value.map((entry) => visit(entry, undefined));
    if (value && typeof value === "object") {
      /** @type {Record<string, unknown>} */
      const output = Object.create(null);
      const entries = Object.entries(
        /** @type {Record<string, unknown>} */ (value),
      ).sort(([left], [right]) => left.localeCompare(right));
      for (const [key, child] of entries) {
        const redactedKey = redactString(key);
        mergeRedactionCounts(counts, redactedKey.counts);
        if (Object.hasOwn(output, redactedKey.value)) {
          throw new Error("redaction-key-collision");
        }
        output[redactedKey.value] = visit(child, key);
      }
      return output;
    }
    return value;
  };

  return { value: visit(input, undefined), counts };
}

/** JSON-encoded UTF-8 size of a string field, including quotes/escaping. */
export function encodedStringBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
