import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, startRedirectServer, api, ACTORS } from "./helpers.js";

/**
 * T-004 — Placement decision — Failure and recovery
 * Point site B at the corrected URL while its printed date is wrong; the
 * item must still request a reprint (INV-02).
 */
test("T-004: corrected URL cannot close an ink mismatch — reprint required", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const agent = ACTORS.agent.id;
  const ops = ACTORS.operator.id;
  const redirector = await startRedirectServer("https://fest.example/sun");

  try {
    const c = await api(app, buyer, "POST", "/api/campaigns", { name: "Fest" });
    const cid = c.json.id;
    const revA = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "poster-v1",
      body: { eventDateText: "Saturday June 6" },
      redirectTarget: "https://fest.example/sat",
    });
    await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "poster-v2",
      body: { eventDateText: "Sunday June 7" },
      redirectTarget: "https://fest.example/sun",
      parentId: revA.json.id,
    });

    // Site B: the date IS in ink AND it carries a managed QR that the
    // operator has already pointed at the corrected destination.
    const siteB = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
      siteCode: "B",
      siteLabel: "Market St shelter",
      format: "A2",
      managedRedirect: true,
      redirectSlug: "hl/market",
      inkFields: ["eventDateText"],
      observedRevisionId: revA.json.id,
    });
    await api(app, ops, "POST", "/api/redirects", {
      slug: "hl/market",
      target: "https://fest.example/sun",
      managedUrl: `${redirector.url}/hl/market`,
    });

    // Evaluate: still REPRINT — the ink itself is wrong (INV-02). Live
    // resolution is irrelevant to an ink mismatch.
    const evalRes = await api(app, agent, "POST", `/api/campaigns/${cid}/plans/evaluate`);
    const b = evalRes.json.results.find((r: any) => r.siteCode === "B");
    assert.equal(b.state, "REPRINT");
    assert.match(b.reason, /ink/);

    const eval2 = await api(app, agent, "POST", `/api/campaigns/${cid}/plans/evaluate`);
    const b2 = eval2.json.results.find((r: any) => r.siteCode === "B");
    assert.equal(b2.state, "REPRINT");

    // Role boundary: a printer cannot evaluate plans.
    const denied = await api(
      app,
      ACTORS.printerA.id,
      "POST",
      `/api/campaigns/${cid}/plans/evaluate`
    );
    assert.equal(denied.status, 403);
  } finally {
    await redirector.close();
    await app.close();
  }
});
