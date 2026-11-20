import type { Db } from "../db/connection.js";

/**
 * Local demo actors. These credentials exist so a reviewer can launch the
 * product locally and drive every role through the browser; they are NOT
 * secrets in any real deployment sense — change or replace the actors table
 * for any environment that matters.
 */
export const DEMO_ACTORS = [
  {
    id: "act_buyer",
    tenant: "tnt_fest",
    role: "buyer",
    printerId: null,
    secret: "sec_buyer",
    contact: "buyer@local.demo",
  },
  {
    id: "act_coord",
    tenant: "tnt_fest",
    role: "coordinator",
    printerId: null,
    secret: "sec_coord",
    contact: "coord@local.demo",
  },
  {
    id: "act_agent",
    tenant: "tnt_fest",
    role: "agent",
    printerId: null,
    secret: "sec_agent",
    contact: "agent@local.demo",
  },
  {
    id: "act_ops",
    tenant: "tnt_fest",
    role: "operator",
    printerId: null,
    secret: "sec_ops",
    contact: "ops@local.demo",
  },
  {
    id: "act_printer_a",
    tenant: "tnt_shop_a",
    role: "printer",
    printerId: "prn_a",
    secret: "sec_printer_a",
    contact: "printer-a@local.demo",
  },
  {
    id: "act_printer_b",
    tenant: "tnt_shop_b",
    role: "printer",
    printerId: "prn_b",
    secret: "sec_printer_b",
    contact: "printer-b@local.demo",
  },
] as const;

/** Seed demo actors only when the actors table is completely empty. */
export function seedDemoActors(db: Db): number {
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM actors")
    .get() as { n: number };
  if (n > 0) return 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO actors (id, tenant_id, role, display_name, printer_id, contact, secret)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const a of DEMO_ACTORS) {
    ins.run(
      a.id,
      a.tenant,
      a.role,
      a.id.replace("act_", ""),
      a.printerId,
      a.contact,
      a.secret
    );
  }
  return DEMO_ACTORS.length;
}
