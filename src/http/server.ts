import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Db } from "../db/connection.js";
import { ApiError } from "../domain/errors.js";
import { authenticate, requireRole, requireScope, type Actor, type Role } from "./auth.js";

export interface RouteResult {
  status?: number;
  body?: unknown;
  /** When set, respond 302 with this Location. */
  redirect?: string;
}

export interface Ctx {
  db: Db;
  actor: Actor | null;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface Route {
  method: string;
  pattern: string;
  /** Unauthenticated endpoint (e.g. health, token issuance). */
  public?: boolean;
  /** When set, the caller's actor role must be one of these. */
  roles?: Role[];
  /** When set, the bearer token must carry this scope. Omit → unauthenticated. */
  scope?: string;
  handler: (ctx: Ctx) => Promise<RouteResult> | RouteResult;
}

interface CompiledRoute {
  method: string;
  regex: RegExp;
  keys: string[];
  public?: boolean;
  roles?: Role[];
  scope?: string;
  handler: Route["handler"];
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const MAX_BODY = 10 * 1024 * 1024; // 10 MB bound on uploads

function compile(route: Route): CompiledRoute {
  const keys: string[] = [];
  const regex = new RegExp(
    "^" +
      route.pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$"
  );
  const out: CompiledRoute = { method: route.method, regex, keys, handler: route.handler };
  if (route.public) out.public = route.public;
  if (route.roles) out.roles = route.roles;
  if (route.scope) out.scope = route.scope;
  return out;
}

export interface AppOptions {
  db: Db;
  routes: Route[];
  staticDir?: string | undefined;
  /**
   * Isolated-demo auth: allows bare `x-actor-id` headers. Off by default;
   * enable only for explicitly isolated demos (PRESSRECALL_DEMO_AUTH=1).
   */
  demoAuth?: boolean | undefined;
}

export function createApp(opts: AppOptions): http.Server {
  const compiled = opts.routes.map(compile);
  const staticDir = opts.staticDir ? normalize(opts.staticDir) : undefined;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      for (const route of compiled) {
        if (route.method !== req.method) continue;
        const m = route.regex.exec(path);
        if (!m) continue;

        const params: Record<string, string> = {};
        route.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1] ?? "");
        });

        let actor: Actor | null = null;
        if (!route.public) {
          actor = authenticate(
            opts.db,
            {
              authorization: header(req, "authorization"),
              actorId: header(req, "x-actor-id"),
            },
            opts.demoAuth === true
          );
          if (route.roles) requireRole(actor, ...route.roles);
          if (route.scope) requireScope(actor, route.scope);
        }

        const raw = await readBody(req);
        let body: unknown = undefined;
        if (raw.length > 0) {
          const ct = header(req, "content-type") ?? "";
          if (ct.includes("application/json")) {
            body = JSON.parse(raw.toString("utf8"));
          } else {
            body = raw;
          }
        }

        const result = await route.handler({
          db: opts.db,
          actor,
          params,
          query: url.searchParams,
          body,
        });
        if (result.redirect) {
          res.writeHead(result.status ?? 302, { location: result.redirect });
          return res.end();
        }
        return sendJson(res, result.status ?? 200, result.body ?? { ok: true });
      }

      // Static files are a fallback for non-API GETs — routes (including
      // the /r/:slug demo redirector) always win first.
      if (req.method === "GET" && staticDir && !path.startsWith("/api")) {
        return await serveStatic(staticDir, path, res);
      }

      sendJson(res, 404, { error: { code: "not_found", message: "no such route" } });
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, {
          error: { code: err.code, message: err.message },
        });
      } else if (err instanceof SyntaxError) {
        sendJson(res, 400, {
          error: { code: "bad_json", message: "request body is not valid JSON" },
        });
      } else {
        console.error("unhandled error", err);
        sendJson(res, 500, {
          error: { code: "internal", message: "internal error" },
        });
      }
    }
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, "too_large", "request body exceeds limit"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function serveStatic(
  root: string,
  path: string,
  res: http.ServerResponse
): Promise<void> {
  let p = path === "/" ? "/index.html" : path;
  const full = normalize(join(root, p));
  if (!full.startsWith(root)) {
    sendJson(res, 403, { error: { code: "forbidden", message: "invalid path" } });
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, {
      "content-type": MIME[extname(full)] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { code: "not_found", message: "no such file" } });
  }
}
