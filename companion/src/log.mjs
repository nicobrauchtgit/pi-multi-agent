import * as fs from "node:fs";
import { secureFile } from "./fsguard.mjs";

const MAX_LOG_BYTES = 256 * 1024;

function rotate(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.size < MAX_LOG_BYTES) return;
    const previous = `${file}.1`;
    try {
      fs.unlinkSync(previous);
    } catch {
      // Missing is expected.
    }
    fs.renameSync(file, previous);
    secureFile(previous);
  } catch {
    // Logging is non-authoritative and must not interrupt storage.
  }
}

export function createLogger(file) {
  return Object.freeze({
    write(event, metadata = {}) {
      try {
        rotate(file);
        const safe = {};
        for (const [key, value] of Object.entries(metadata)) {
          if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(key)) continue;
          if (typeof value === "boolean" || Number.isFinite(value))
            safe[key] = value;
          else if (
            typeof value === "string" &&
            /^[a-zA-Z0-9_.:-]{1,80}$/.test(value)
          )
            safe[key] = value;
        }
        const line = `${JSON.stringify({
          at: Date.now(),
          event: String(event)
            .replace(/[^a-zA-Z0-9_.-]/g, "_")
            .slice(0, 80),
          ...safe,
        })}\n`;
        const fd = fs.openSync(
          file,
          fs.constants.O_WRONLY |
            fs.constants.O_APPEND |
            fs.constants.O_CREAT |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.fchmodSync(fd, 0o600);
          fs.writeFileSync(fd, line, "utf8");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // Never turn an operational log failure into an ingest failure.
      }
    },
  });
}
