import type { SQLInputValue } from "node:sqlite";
import type { Db } from "./connection.js";

/** Typed single-row query. */
export function qget<T>(
  db: Db,
  sql: string,
  ...params: SQLInputValue[]
): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

/** Typed multi-row query. */
export function qall<T>(
  db: Db,
  sql: string,
  ...params: SQLInputValue[]
): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

/** Parameterized write; returns driver result. */
export function qrun(db: Db, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}
