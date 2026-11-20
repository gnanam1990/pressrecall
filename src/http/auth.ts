import { randomBytes } from "node:crypto";
import type { Db } from "../db/connection.js";
import { qget, qrun } from "../db/query.js";
import { unauthorized, forbidden, badRequest } from "../domain/errors.js";
import { nowIso } from "../domain/ids.js";

export type Role = "buyer" | "coordinator" | "printer" | "agent" | "operator";

export interface Actor {
  id: string;
  tenantId: string;
  role: Role;
  displayName: string;
  printerId: string | null;
  scopes: string[];
}

interface ActorRow {
  id: string;
  tenant_id: string;
  role: Role;
  display_name: string;
  printer_id: string | null;
  secret: string | null;
}

/**
 * Capability scopes. Every authenticated route declares the single scope it
 * requires; a token may carry at most the scopes its actor's role allows.
 */
export const ROLE_SCOPES: Record<Role, string[]> = {
  buyer: [
    "campaigns:read",
    "campaigns:write",
    "revisions:write",
    "placements:write",
    "observations:write",
    "quotes:read",
    "quotes:write",
    "approvals:write",
    "intents:write",
    "jobs:read",
    "release:read",
    "exports:read",
    "grants:write",
    "redirects:read",
  ],
  coordinator: [
    "campaigns:read",
    "observations:write",
    "evidence:write",
    "release:read",
  ],
  agent: [
    "campaigns:read",
    "placements:write",
    "observations:write",
    "plans:evaluate",
    "intents:write",
    "quotes:write",
    "release:read",
    "redirects:read",
  ],
  printer: [
    "quotes:read",
    "quotes:write",
    "proofs:write",
    "jobs:read",
    "jobs:write",
    "intents:reserve",
    "fulfillment:write",
  ],
  operator: ["campaigns:read", "redirects:write", "redirects:read"],
};

function actorFrom(row: ActorRow, scopes: string[]): Actor {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    role: row.role,
    displayName: row.display_name,
    printerId: row.printer_id,
    scopes,
  };
}

/**
 * Issue a scoped bearer token for an actor. Authenticates the actor's local
 * secret — this is the honest local credential boundary (no external IdP).
 * Requested scopes are intersected with the role's allowed set; asking for a
 * scope outside the role fails rather than silently widening.
 */
export function mintToken(
  db: Db,
  input: { actorId: string; secret: string; scopes?: string[]; expiresAt?: string }
): { token: string; actor: Actor } {
  const row = qget<ActorRow>(
    db,
    "SELECT id, tenant_id, role, display_name, printer_id, secret FROM actors WHERE id = ?",
    input.actorId
  );
  if (!row || !row.secret || row.secret !== input.secret) {
    throw unauthorized("invalid actor credentials");
  }
  const allowed = ROLE_SCOPES[row.role];
  const scopes = input.scopes ?? [...allowed];
  for (const s of scopes) {
    if (!allowed.includes(s)) {
      throw forbidden(`role '${row.role}' cannot be granted scope '${s}'`);
    }
  }
  const token = `prt_${randomBytes(24).toString("hex")}`;
  qrun(
    db,
    `INSERT INTO auth_tokens (token, actor_id, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    token,
    row.id,
    JSON.stringify(scopes),
    nowIso(),
    input.expiresAt ?? null
  );
  return { token, actor: actorFrom(row, scopes) };
}

/**
 * Resolve the request's caller.
 *
 * Normal path: `Authorization: Bearer prt_…` → token lookup, revoked/expired
 * rejected, scopes attached.
 *
 * Isolated-demo path: when `demoAuth` is explicitly enabled, a bare
 * `x-actor-id` header resolves with full role scopes and is labeled DEMO in
 * the actor id source — never enabled by default.
 */
export function authenticate(
  db: Db,
  headers: { authorization?: string; actorId?: string },
  demoAuth: boolean
): Actor {
  const auth = headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    const row = qget<
      ActorRow & { scopes: string; expires_at: string | null; revoked_at: string | null }
    >(
      db,
      `SELECT a.id, a.tenant_id, a.role, a.display_name, a.printer_id, a.secret,
              t.scopes, t.expires_at, t.revoked_at
         FROM auth_tokens t JOIN actors a ON a.id = t.actor_id
        WHERE t.token = ?`,
      token
    );
    if (!row) throw unauthorized("unknown or malformed token");
    if (row.revoked_at) throw unauthorized("token revoked");
    if (row.expires_at && row.expires_at <= nowIso()) {
      throw unauthorized("token expired");
    }
    return actorFrom(row, JSON.parse(row.scopes) as string[]);
  }
  if (demoAuth && headers.actorId) {
    const row = qget<ActorRow>(
      db,
      "SELECT id, tenant_id, role, display_name, printer_id, secret FROM actors WHERE id = ?",
      headers.actorId
    );
    if (!row) throw unauthorized(`unknown actor '${headers.actorId}'`);
    return actorFrom(row, [...ROLE_SCOPES[row.role]]);
  }
  throw unauthorized();
}

export function revokeToken(db: Db, token: string): void {
  const res = qrun(
    db,
    "UPDATE auth_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL",
    nowIso(),
    token
  );
  if (res.changes === 0) throw badRequest("token not found or already revoked");
}

export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) {
    throw forbidden(`role '${actor.role}' cannot perform this action`);
  }
}

export function requireScope(actor: Actor, scope: string): void {
  if (!actor.scopes.includes(scope)) {
    throw forbidden(`token lacks required scope '${scope}'`);
  }
}
