import { join } from "node:path";
import { openDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { seedDemoActors } from "./actors/demo.js";
import {
  assertLiveStartAllowed,
  liveAdapterSelected,
} from "./live-guard.js";
import { createApp } from "./http/server.js";
import { buildRoutes } from "./http/routes.js";
import { SandboxChainAdapter } from "./chain/sandbox.js";
import { AltanaAdapter } from "./chain/altana.js";
import type { SignerAdapter } from "./chain/adapter.js";
import type { Address } from "viem";

const varDir = process.env.PRESSRECALL_VAR_DIR ?? join(process.cwd(), "var");
const dbPath = process.env.PRESSRECALL_DB ?? join(varDir, "pressrecall.db");
const objectDir =
  process.env.PRESSRECALL_OBJECT_DIR ?? join(varDir, "objects");
const webDir = join(process.cwd(), "web");
const port = Number(process.env.PORT ?? 4173);

const db = openDb(dbPath);
const applied = migrate(db);
if (applied.length) {
  console.log(`applied migrations: ${applied.join(", ")}`);
}

// First launch on a fresh database seeds the documented local demo actors
// so the browser sign-in works out of the box — SANDBOX MODE ONLY. Demo
// credentials are public and must never exist alongside a real provider.
const liveMode = liveAdapterSelected(process.env);
if (!liveMode) {
  const seeded = seedDemoActors(db);
  if (seeded) {
    console.log(
      `seeded ${seeded} local demo actors — credentials documented in README`
    );
  }
}

/**
 * Settlement adapter selection — sandbox is the default and only enabled
 * path. `PRESSRECALL_CHAIN_ADAPTER=altana` opts in to the real
 * @altananetwork/sdk path; it still cannot spend until grants carry real
 * session material (session_data) and PRESSRECALL_ALTANA_TOKENS maps each
 * accepted token symbol to its contract. Without that configuration every
 * send is denied as NOT_CONFIGURED — nothing can broadcast by default.
 */
function buildChainAdapter(): SignerAdapter {
  if (process.env.PRESSRECALL_CHAIN_ADAPTER !== "altana") {
    return new SandboxChainAdapter(db);
  }
  let tokenAddresses: Record<string, Address> = {};
  try {
    tokenAddresses = JSON.parse(
      process.env.PRESSRECALL_ALTANA_TOKENS ?? "{}"
    ) as Record<string, Address>;
  } catch {
    tokenAddresses = {};
  }
  console.warn(
    "altana adapter selected (real provider). Without session material and token config all sends deny as NOT_CONFIGURED."
  );
  return new AltanaAdapter({ tokenAddresses });
}

// Live mode refuses to start with public demo credentials or the
// isolated-demo auth path present.
try {
  assertLiveStartAllowed(db, process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const server = createApp({
  db,
  routes: buildRoutes({
    objectDir,
    chain: buildChainAdapter(),
    redirectPolicy: {
      // Tightly scoped site policy: only these hostnames may be resolved by
      // the destination fetcher. Default covers local demo/operator services.
      allowedHosts: (
        process.env.PRESSRECALL_REDIRECT_ALLOWED_HOSTS ?? "127.0.0.1,localhost"
      )
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
    },
  }),
  staticDir: webDir,
  // Isolated-demo auth ONLY when explicitly requested; never default.
  demoAuth: process.env.PRESSRECALL_DEMO_AUTH === "1",
});

// Local sandbox binds loopback by default; set PRESSRECALL_BIND to expose
// the service (e.g. a LAN field demo) deliberately.
const bind = process.env.PRESSRECALL_BIND ?? "127.0.0.1";
server.listen(port, bind, () => {
  console.log(`pressrecall listening on http://${bind}:${port}`);
  console.log(`db=${dbPath} objects=${objectDir}`);
});
