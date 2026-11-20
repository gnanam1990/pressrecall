#!/usr/bin/env node
// Provision a real actor for live mode. Demo actors are never created in
// live mode — use this script (or equivalent SQL) to insert actors with
// unique secrets, then sign in via POST /api/auth/token.
//
// Usage:
//   npm run build
//   node scripts/provision-actor.mjs <actorId> <tenantId> <role> <secret> [printerId]
//
// Roles: buyer | coordinator | agent | printer | operator
// The database must already exist (run `npm start` once to migrate it).
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const [, , id, tenant, role, secret, printerId = null] = process.argv;
const roles = new Set(["buyer", "coordinator", "agent", "printer", "operator"]);
if (!id || !tenant || !role || !secret || !roles.has(role)) {
  console.error(
    "usage: provision-actor.mjs <actorId> <tenantId> <role> <secret> [printerId]\n" +
      "roles: buyer | coordinator | agent | printer | operator"
  );
  process.exit(2);
}
if (secret.startsWith("sec_")) {
  console.error("refusing a demo-shaped secret — choose a unique secret");
  process.exit(2);
}

const dbPath =
  process.env.PRESSRECALL_DB ??
  join(process.env.PRESSRECALL_VAR_DIR ?? join(process.cwd(), "var"), "pressrecall.db");
const db = new DatabaseSync(dbPath);
try {
  db.prepare(
    `INSERT INTO actors (id, tenant_id, role, display_name, printer_id, contact, secret)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenant, role, id, printerId, `${id}@provisioned`, secret);
  console.log(`provisioned actor ${id} role=${role} tenant=${tenant}`);
} catch (err) {
  console.error(`failed: ${err.message}`);
  process.exit(1);
}
