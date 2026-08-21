import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "../constants.mjs";
import { migrateDatabase, userVersion } from "./migrate.mjs";

function applyConnectionPragmas(db) {
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
}

function scalar(db, sql, key) {
  return db.prepare(sql).get()[key];
}

export function openDatabase(file, options = {}) {
  const existed = fs.existsSync(file);
  const db = new DatabaseSync(file);
  try {
    applyConnectionPragmas(db);
    const before = userVersion(db);
    if (before > SCHEMA_VERSION) {
      // Refuse before any persistent journal-mode change.
      migrateDatabase(db, options);
    }
    if (!existed || before === 0) {
      // auto_vacuum must be selected before WAL creates the first database
      // pages; both still precede every application-table DDL statement.
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      if (Number(scalar(db, "PRAGMA auto_vacuum", "auto_vacuum")) !== 2) {
        throw new Error("incremental-auto-vacuum-unavailable");
      }
      const journal = String(
        scalar(db, "PRAGMA journal_mode = WAL", "journal_mode"),
      );
      if (journal.toLowerCase() !== "wal") throw new Error("wal-unavailable");
    }
    const version = migrateDatabase(db, options);
    const journal = String(
      scalar(db, "PRAGMA journal_mode = WAL", "journal_mode"),
    );
    const autoVacuum = Number(scalar(db, "PRAGMA auto_vacuum", "auto_vacuum"));
    if (journal.toLowerCase() !== "wal") throw new Error("wal-unavailable");
    if (autoVacuum !== 2)
      throw new Error("incremental-auto-vacuum-unavailable");
    applyConnectionPragmas(db);
    return { db, version, journalMode: journal, autoVacuum };
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the original startup error.
    }
    if (
      error &&
      typeof error === "object" &&
      Number.isInteger(error.exitCode)
    ) {
      throw error;
    }
    if (
      error &&
      typeof error === "object" &&
      (error.errcode === 11 ||
        error.errcode === 26 ||
        /(?:malformed|not a database|corrupt)/i.test(
          String(error.message ?? ""),
        ))
    ) {
      throw Object.assign(error, { code: "database-corrupt", exitCode: 74 });
    }
    throw Object.assign(
      error instanceof Error ? error : new Error("database-open-failed"),
      {
        code: "database-open-failed",
        exitCode: 73,
      },
    );
  }
}

export function openReadOnlyDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA query_only = ON");
  return db;
}

export function checkpointAndClose(db) {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Shutdown still closes the connection after a failed checkpoint.
  }
  db.close();
}
