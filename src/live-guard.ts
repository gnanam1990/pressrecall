import type { Db } from "./db/connection.js";
import { DEMO_ACTORS } from "./actors/demo.js";

/**
 * Live-mode startup guard.
 *
 * The local sandbox may seed documented demo actors so the product is
 * usable out of the box. Live mode (Altana adapter) is different: demo
 * credentials are public, so they must never exist alongside a real
 * provider, and the isolated-demo actor-header path must be off.
 */

export function liveAdapterSelected(env: NodeJS.ProcessEnv): boolean {
  return env.PRESSRECALL_CHAIN_ADAPTER === "altana";
}

/** Demo actors whose stored secret still equals the documented one. */
export function demoActorsPresent(db: Db): string[] {
  const found: string[] = [];
  const sel = db.prepare("SELECT secret FROM actors WHERE id = ?");
  for (const a of DEMO_ACTORS) {
    const row = sel.get(a.id) as { secret: string | null } | undefined;
    if (row && row.secret === a.secret) found.push(a.id);
  }
  return found;
}

/**
 * Throws when the environment or database cannot start live mode safely.
 * Pure function of db + env — testable without binding a port or network.
 */
export function assertLiveStartAllowed(db: Db, env: NodeJS.ProcessEnv): void {
  if (!liveAdapterSelected(env)) return;
  if (env.PRESSRECALL_DEMO_AUTH === "1") {
    throw new Error(
      "refusing live start: PRESSRECALL_DEMO_AUTH=1 enables the isolated-demo " +
        "actor-header path, which must never coexist with a real provider"
    );
  }
  const demo = demoActorsPresent(db);
  if (demo.length) {
    throw new Error(
      "refusing live start: documented demo credentials are present in the " +
        `actors table (${demo.join(", ")}). Provision real actors with ` +
        "unique secrets and remove the demo rows before enabling the " +
        "Altana adapter."
    );
  }
}
