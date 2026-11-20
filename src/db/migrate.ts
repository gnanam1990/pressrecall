import type { Db } from "./connection.js";
import { migrations } from "./migrations.js";

export function migrate(db: Db): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
  );
  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));
  const nowApplied: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(m.version, m.name, new Date().toISOString());
      db.exec("COMMIT");
      nowApplied.push(m.version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return nowApplied;
}
