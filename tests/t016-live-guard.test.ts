import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { seedDemoActors, DEMO_ACTORS } from "../src/actors/demo.js";
import {
  assertLiveStartAllowed,
  demoActorsPresent,
  liveAdapterSelected,
} from "../src/live-guard.js";

/**
 * T-016 — Live-mode startup guard (no network): the Altana path must
 * refuse to boot alongside documented demo credentials or the
 * isolated-demo actor-header path, while sandbox keeps working.
 */

const live = { PRESSRECALL_CHAIN_ADAPTER: "altana" } as NodeJS.ProcessEnv;
const sandbox = {} as NodeJS.ProcessEnv;

test("T-016: live start refuses demo credentials and demo auth; sandbox unaffected", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-guard-"));
  const db = openDb(join(dir, "t.db"));
  migrate(db);

  assert.equal(liveAdapterSelected(live), true);
  assert.equal(liveAdapterSelected(sandbox), false);

  // Fresh db, no demo actors → live start allowed (still cannot spend
  // without session material + token config — enforced in the adapter).
  assert.doesNotThrow(() => assertLiveStartAllowed(db, live));

  // Demo-auth flag + live adapter → refuse.
  assert.throws(
    () =>
      assertLiveStartAllowed(db, {
        PRESSRECALL_CHAIN_ADAPTER: "altana",
        PRESSRECALL_DEMO_AUTH: "1",
      } as NodeJS.ProcessEnv),
    /PRESSRECALL_DEMO_AUTH/
  );

  // Seed demo actors → live start must refuse; sandbox unaffected.
  seedDemoActors(db);
  assert.deepEqual(demoActorsPresent(db).sort(), DEMO_ACTORS.map((a) => a.id).sort());
  assert.throws(
    () => assertLiveStartAllowed(db, live),
    /demo credentials are present/
  );
  assert.doesNotThrow(() => assertLiveStartAllowed(db, sandbox));

  // Rotated secrets are no longer the documented demo credentials.
  db.prepare("UPDATE actors SET secret = ? WHERE id = ?").run(
    "unique-live-secret-1",
    DEMO_ACTORS[0].id
  );
  assert.equal(demoActorsPresent(db).includes(DEMO_ACTORS[0].id), false);

  // Remove all demo-shaped rows → live start allowed again.
  for (const a of DEMO_ACTORS) {
    db.prepare("DELETE FROM actors WHERE id = ?").run(a.id);
  }
  assert.doesNotThrow(() => assertLiveStartAllowed(db, live));
  db.close();
});
