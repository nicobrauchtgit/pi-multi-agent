import { Buffer } from "node:buffer";

/** Truncate a string without splitting a UTF-8 code point. */
export function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) {
    end--;
  }
  return buffer.subarray(0, end).toString("utf8");
}
