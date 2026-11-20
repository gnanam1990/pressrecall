import { join } from "node:path";
import { openDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./http/server.js";
import { buildRoutes } from "./http/routes.js";

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

const server = createApp({
  db,
  routes: buildRoutes({
    objectDir,
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

server.listen(port, () => {
  console.log(`pressrecall listening on http://localhost:${port}`);
  console.log(`db=${dbPath} objects=${objectDir}`);
});
