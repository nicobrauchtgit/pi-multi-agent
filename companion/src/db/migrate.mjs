import { EXIT, SCHEMA_VERSION } from "../constants.mjs";
import { SCHEMA_V1_SQL } from "./schema-v1.mjs";

export class MigrationError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = "MigrationError";
    this.code = reason;
    this.exitCode = EXIT.MIGRATION;
    this.detail = detail;
  }
}

export function userVersion(db) {
  return Number(db.prepare("PRAGMA user_version").get().user_version);
}

export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    apply(db, options = {}) {
      db.exec(SCHEMA_V1_SQL);
      if (options.injectFailureAt === 1)
        throw new Error("injected-migration-failure");
    },
  }),
]);

export function migrateDatabase(db, options = {}) {
  let current = userVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new MigrationError("schema-newer-than-binary", {
      databaseVersion: current,
      supportedVersion: SCHEMA_VERSION,
    });
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    if (migration.version !== current + 1) {
      throw new MigrationError("migration-order-invalid");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(db, options);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      current = migration.version;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original migration error remains authoritative.
      }
      throw new MigrationError("migration-failed", {
        version: migration.version,
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return current;
}
