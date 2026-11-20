import type { Db } from "../db/connection.js";
import { unauthorized, forbidden } from "../domain/errors.js";

export type Role = "buyer" | "coordinator" | "printer" | "agent" | "operator";

export interface Actor {
  id: string;
  tenantId: string;
  role: Role;
  displayName: string;
  printerId: string | null;
}

/**
 * Dev-mode actor resolution. Callers present `x-actor-id`; the server looks up
 * the registered actor and derives role/tenant scope. This is an honest local
 * boundary — no passwords, no external IdP — documented as such.
 */
export function resolveActor(db: Db, actorId: string | undefined): Actor {
  if (!actorId) throw unauthorized();
  const row = db
    .prepare(
      "SELECT id, tenant_id, role, display_name, printer_id FROM actors WHERE id = ?"
    )
    .get(actorId) as
    | {
        id: string;
        tenant_id: string;
        role: Role;
        display_name: string;
        printer_id: string | null;
      }
    | undefined;
  if (!row) throw unauthorized(`unknown actor '${actorId}'`);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    role: row.role,
    displayName: row.display_name,
    printerId: row.printer_id,
  };
}

export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) {
    throw forbidden(`role '${actor.role}' cannot perform this action`);
  }
}
