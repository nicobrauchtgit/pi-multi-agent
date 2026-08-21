import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BUILD_VERSION, EXIT, SCHEMA_VERSION } from "./constants.mjs";
import { openReadOnlyDatabase } from "./db/open.mjs";
import { userVersion } from "./db/migrate.mjs";
import {
  APPLICATION_TABLES,
  EXPLICIT_INDEXES,
  INDEX_COLUMNS,
  INTERNAL_TABLES,
  SCHEMA_V1_SQL,
  TABLE_COLUMNS,
} from "./db/schema-v1.mjs";
import { loadMetrics } from "./metrics.mjs";

export class CorruptionError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = "CorruptionError";
    this.code = reason;
    this.exitCode = EXIT.CORRUPT;
    this.detail = detail;
  }
}

function fileSize(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function normalizedSchemaObjects(db) {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'index', 'trigger', 'view')
       ORDER BY type, name`,
    )
    .all()
    .map((row) => ({
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      sql: String(row.sql).replace(/\s+/g, "").toLowerCase(),
    }));
}

let expectedSchemaObjects;
function canonicalSchemaObjects() {
  if (expectedSchemaObjects) return expectedSchemaObjects;
  const golden = new DatabaseSync(":memory:");
  try {
    golden.exec(SCHEMA_V1_SQL);
    expectedSchemaObjects = normalizedSchemaObjects(golden);
    return expectedSchemaObjects;
  } finally {
    golden.close();
  }
}

export function assertGoldenSchema(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);
  const application = tables.filter((name) => !name.startsWith("sqlite_"));
  if (JSON.stringify(application) !== JSON.stringify(APPLICATION_TABLES)) {
    throw new CorruptionError("application-table-drift", {
      tables: application,
    });
  }
  for (const internal of INTERNAL_TABLES) {
    if (!tables.includes(internal))
      throw new CorruptionError("internal-table-missing");
  }
  for (const [table, expectedColumns] of Object.entries(TABLE_COLUMNS)) {
    const actualColumns = db
      .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
      .all()
      .map((row) => row.name);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
      throw new CorruptionError("table-column-drift", { table });
    }
  }
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  if (JSON.stringify(indexes) !== JSON.stringify(EXPLICIT_INDEXES)) {
    throw new CorruptionError("index-drift", { indexes });
  }
  for (const [name, expected] of Object.entries(INDEX_COLUMNS)) {
    const actual = db
      .prepare(`PRAGMA index_info(${JSON.stringify(name)})`)
      .all()
      .map((row) => row.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new CorruptionError("index-column-drift", { index: name });
    }
  }
  if (
    JSON.stringify(normalizedSchemaObjects(db)) !==
    JSON.stringify(canonicalSchemaObjects())
  ) {
    throw new CorruptionError("schema-definition-drift");
  }
  const strictRows = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((row) => APPLICATION_TABLES.includes(row.name));
  if (
    strictRows.length !== 3 ||
    strictRows.some((row) => Number(row.strict) !== 1)
  ) {
    throw new CorruptionError("strict-table-drift");
  }
  return true;
}

export function quickCheckDatabase(db) {
  const version = userVersion(db);
  if (version > SCHEMA_VERSION) {
    throw Object.assign(new Error("schema-newer-than-binary"), {
      code: "schema-newer-than-binary",
      exitCode: 73,
    });
  }
  if (version !== SCHEMA_VERSION)
    throw new CorruptionError("schema-version-mismatch");
  const journalMode = String(
    db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "",
  ).toLowerCase();
  const autoVacuum = Number(
    db.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum ?? -1,
  );
  if (journalMode !== "wal" || autoVacuum !== 2) {
    throw new CorruptionError("database-pragma-drift");
  }
  const quick = db
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => row.quick_check);
  if (quick.length !== 1 || quick[0] !== "ok")
    throw new CorruptionError("quick-check-failed");
  const foreign = db.prepare("PRAGMA foreign_key_check").all();
  if (foreign.length !== 0)
    throw new CorruptionError("foreign-key-check-failed");
  assertGoldenSchema(db);
  return {
    ok: true,
    schemaVersion: version,
    quickCheck: "ok",
    foreignKeyViolations: 0,
  };
}

export function quickCheckFile(paths) {
  const db = openReadOnlyDatabase(paths.database);
  try {
    return quickCheckDatabase(db);
  } finally {
    db.close();
  }
}

export function status(paths) {
  if (!fs.existsSync(paths.database)) {
    return {
      available: false,
      buildVersion: BUILD_VERSION,
      schemaVersion: null,
      currentSeq: 0,
      minSeq: null,
      eventCount: 0,
      countsByKind: {},
      sizes: { database: 0, wal: 0, shm: 0 },
      metrics: loadMetrics(paths.metrics),
    };
  }
  const db = openReadOnlyDatabase(paths.database);
  try {
    const version = userVersion(db);
    const range = db
      .prepare(
        "SELECT MIN(seq) AS min_seq, MAX(seq) AS max_seq, COUNT(*) AS count FROM events",
      )
      .get() ?? { min_seq: null, max_seq: null, count: 0 };
    const countsByKind = Object.fromEntries(
      db
        .prepare(
          "SELECT event_kind, COUNT(*) AS count FROM events GROUP BY event_kind ORDER BY event_kind",
        )
        .all()
        .map((row) => [row.event_kind, Number(row.count)]),
    );
    return {
      available: true,
      buildVersion: BUILD_VERSION,
      schemaVersion: version,
      currentSeq: Number(range.max_seq ?? 0),
      minSeq: range.min_seq === null ? null : Number(range.min_seq),
      eventCount: Number(range.count),
      countsByKind,
      sizes: {
        database: fileSize(paths.database),
        wal: fileSize(paths.wal),
        shm: fileSize(paths.shm),
      },
      metrics: loadMetrics(paths.metrics),
    };
  } finally {
    db.close();
  }
}
