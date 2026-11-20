import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  buyer: { id: "act_buyer", tenant: "tnt_fest", role: "buyer", secret: "sec_buyer" },
  buyer2: { id: "act_buyer2", tenant: "tnt_other", role: "buyer", secret: "sec_buyer2" },
  coordinator: { id: "act_coord", tenant: "tnt_fest", role: "coordinator", secret: "sec_coord" },
  agent: { id: "act_agent", tenant: "tnt_fest", role: "agent", secret: "sec_agent" },
  operator: { id: "act_ops", tenant: "tnt_fest", role: "operator", secret: "sec_ops" },
  printerA: {
    id: "act_printer_a",
    tenant: "tnt_shop_a",
    role: "printer",
    printerId: "prn_a",
    secret: "sec_printer_a",
  },
  printerB: {
    id: "act_printer_b",
    tenant: "tnt_shop_b",
    role: "printer",
    printerId: "prn_b",
    secret: "sec_printer_b",
  },
} as const;

export type ActorKey = keyof typeof ACTORS;

export function secretFor(actorId: string): string {
  const a = Object.values(ACTORS).find((x) => x.id === actorId);
  if (!a) throw new Error(`no seeded actor ${actorId}`);
  return a.secret;
}

export function seedActors(db: Db): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO actors (id, tenant_id, role, display_name, printer_id, contact, secret)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const a of Object.values(ACTORS)) {
    ins.run(
      a.id,
      a.tenant,
      a.role,
      a.id.replace("act_", ""),
      "printerId" in a ? a.printerId : null,
      `${a.id}@internal`,
      a.secret
    );
  }
}

export async function startApp(opts?: {
  dbPath?: string;
  varDir?: string;
  demoAuth?: boolean;
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
    routes: buildRoutes({
      objectDir,
      redirectPolicy: { allowedHosts: ["127.0.0.1", "localhost"] },
      ...opts?.extra,
    }),
    staticDir: undefined,
    demoAuth: opts?.demoAuth === true,
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

/**
 * Independent operator redirect service: a separate local HTTP server that
 * 302s to a mutable target — what an installed QR actually resolves to.
 */
export async function startRedirectServer(initialLocation: string): Promise<{
  url: string;
  setLocation: (loc: string) => void;
  close: () => Promise<void>;
}> {
  const { createServer } = await import("node:http");
  let location = initialLocation;
  const server = createServer((req, res) => {
    res.writeHead(302, { location });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    setLocation: (loc) => {
      location = loc;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Mint a scoped token for a seeded actor. */
export async function mintToken(
  app: TestApp,
  actorId: string,
  opts?: { scopes?: string[]; expiresAt?: string; secret?: string }
): Promise<string> {
  const res = await apiRaw(app, "POST", "/api/auth/token", {
    actorId,
    secret: opts?.secret ?? secretFor(actorId),
    scopes: opts?.scopes,
    expiresAt: opts?.expiresAt,
  });
  if (res.status !== 201) {
    throw new Error(`token mint failed: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json.token as string;
}

/** Authenticated call: mints a full-role token for the actor. */
export async function api(
  app: TestApp,
  actorId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResult> {
  return apiToken(app, await mintToken(app, actorId), method, path, body);
}

/** Call with an explicit bearer token. */
export async function apiToken(
  app: TestApp,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResult> {
  return request(app, method, path, body, { authorization: `Bearer ${token}` });
}

/** Legacy isolated-demo call: bare actor header, no token. */
export async function apiBare(
  app: TestApp,
  actorId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResult> {
  return request(app, method, path, body, { "x-actor-id": actorId });
}

/** Unauthenticated call. */
export async function apiRaw(
  app: TestApp,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResult> {
  return request(app, method, path, body, {});
}

async function request(
  app: TestApp,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>
): Promise<ApiResult> {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: {
      ...headers,
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
