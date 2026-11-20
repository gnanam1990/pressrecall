import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createApp } from "../src/http/server.js";
import { buildRoutes, type AppContext } from "../src/http/routes.js";

export interface TestApp {
  url: string;
  dbPath: string;
  objectDir: string;
  varDir: string;
  close: () => Promise<void>;
  db: Db;
}

export const ACTORS = {
  buyer: { id: "act_buyer", tenant: "tnt_fest", role: "buyer" },
  buyer2: { id: "act_buyer2", tenant: "tnt_other", role: "buyer" },
  coordinator: { id: "act_coord", tenant: "tnt_fest", role: "coordinator" },
  agent: { id: "act_agent", tenant: "tnt_fest", role: "agent" },
  operator: { id: "act_ops", tenant: "tnt_fest", role: "operator" },
  printerA: {
    id: "act_printer_a",
    tenant: "tnt_shop_a",
    role: "printer",
    printerId: "prn_a",
  },
  printerB: {
    id: "act_printer_b",
    tenant: "tnt_shop_b",
    role: "printer",
    printerId: "prn_b",
  },
} as const;

export function seedActors(db: Db): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO actors (id, tenant_id, role, display_name, printer_id, contact)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const a of Object.values(ACTORS)) {
    ins.run(
      a.id,
      a.tenant,
      a.role,
      a.id.replace("act_", ""),
      "printerId" in a ? a.printerId : null,
      `${a.id}@internal`
    );
  }
}

export async function startApp(opts?: {
  dbPath?: string;
  varDir?: string;
  extra?: Partial<AppContext>;
}): Promise<TestApp> {
  const varDir = opts?.varDir ?? mkdtempSync(join(tmpdir(), "pressrecall-"));
  mkdirSync(varDir, { recursive: true });
  const dbPath = opts?.dbPath ?? join(varDir, "test.db");
  const objectDir = join(varDir, "objects");
  mkdirSync(objectDir, { recursive: true });

  const db = openDb(dbPath);
  migrate(db);
  seedActors(db);

  const server = createApp({
    db,
    routes: buildRoutes({ objectDir, ...opts?.extra }),
    staticDir: undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://localhost:${port}`,
    dbPath,
    objectDir,
    varDir,
    db,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

export interface ApiResult {
  status: number;
  json: any;
}

export async function api(
  app: TestApp,
  actorId: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResult> {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: {
      ...(actorId ? { "x-actor-id": actorId } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}
