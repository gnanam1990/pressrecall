import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createApp } from "../src/http/server.js";
import { buildRoutes, type AppContext } from "../src/http/routes.js";
import { SandboxChainAdapter } from "../src/chain/sandbox.js";

export interface TestApp {
  url: string;
  dbPath: string;
  objectDir: string;
  varDir: string;
  close: () => Promise<void>;
  db: Db;
  chain: SandboxChainAdapter;
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
  const chain = new SandboxChainAdapter(db);

  const server = createApp({
    db,
    routes: buildRoutes({
      objectDir,
      chain,
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
    chain,
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
 * Full pipeline: campaign + revA→revB, placement observing revA, quote
 * request, quote, proof, approval, grant, intent, shop reserve.
 * Returns ids for the settlement/fulfillment/release tests.
 */
export async function pipeline(app: TestApp, opts?: {
  priceAtoms?: number;
  capAtoms?: number;
  fundedBy?: string;
  settle?: boolean;
  /** Create through approval only — caller drives intents itself. */
  noIntent?: boolean;
}) {
  const buyer = ACTORS.buyer.id;
  const agent = ACTORS.agent.id;
  const printer = ACTORS.printerA.id;
  const c = await api(app, buyer, "POST", "/api/campaigns", {
    name: "Fest",
    budgetCapAtoms: opts?.capAtoms ?? 200000,
  });
  const cid = c.json.id as string;
  const revA = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
    assetText: "v1",
    body: { eventDateText: "Saturday June 6" },
  });
  const revB = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
    assetText: "v2",
    body: { eventDateText: "Sunday June 7" },
    parentId: revA.json.id,
  });
  const site = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
    siteCode: "B",
    siteLabel: "Market St",
    format: "A2",
    inkFields: ["eventDateText"],
    observedRevisionId: revA.json.id,
  });
  const pid = site.json.id as string;
  const rfq = await api(app, agent, "POST", `/api/campaigns/${cid}/quote-requests`, {
    planItemId: site.json.planItem.id,
    revisionId: revB.json.id,
    dimensions: "594x841mm",
    deadline: "2026-12-03",
    qty: 1,
  });
  const q = await api(app, printer, "POST", `/api/printer/quote-requests/${rfq.json.id}/quotes`, {
    qty: 1,
    priceAtoms: opts?.priceAtoms ?? 42000,
    token: "USD",
    network: "SANDBOX",
    recipient: "acct_printer_a",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const proof = await api(app, printer, "POST", `/api/printer/quote-requests/${rfq.json.id}/proofs`, {
    assetText: "PROOF — revB",
  });
  const appr = await api(app, buyer, "POST", `/api/campaigns/${cid}/approvals`, {
    quoteId: q.json.id,
    proofId: proof.json.id,
  });
  if (opts?.noIntent) {
    return {
      cid, pid,
      revA: revA.json, revB: revB.json,
      approvalId: appr.json.id as string,
      intentId: null as unknown as string,
      spend: null,
    };
  }
  await api(app, buyer, "POST", `/api/campaigns/${cid}/grants`, {
    sessionId: `sess_${cid}`,
    maxAmountAtoms: 500000,
    token: "USD",
    network: "SANDBOX",
    allowedPayees: ["acct_printer_a"],
  });
  const intent = await api(app, agent, "POST", `/api/campaigns/${cid}/order-intents`, {
    approvalId: appr.json.id,
    clientKey: `ck_${cid}_${site.json.planItem.id}`,
  });
  await api(app, printer, "POST", `/api/order-intents/${intent.json.id}/reserve`, {
    shopRef: `REF-${intent.json.id}`,
  });
  let spend: ApiResult | null = null;
  if (opts?.settle) {
    spend = await api(app, agent, "POST", `/api/order-intents/${intent.json.id}/execute`, {
      fundedBy: opts?.fundedBy,
    });
  }
  return {
    cid, pid,
    revA: revA.json, revB: revB.json,
    approvalId: appr.json.id as string,
    intentId: intent.json.id as string,
    spend: spend?.json,
  };
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
