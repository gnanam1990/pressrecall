import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS } from "./helpers.js";

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

    // Site B: the date IS in ink AND it carries a managed QR.
    const siteB = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
      siteCode: "B",
      siteLabel: "Market St shelter",
      format: "A2",
      managedRedirect: true,
      redirectSlug: "hl/market",
      inkFields: ["eventDateText"],
      observedRevisionId: revA.json.id,
    });
    const itemB = siteB.json.planItem.id;

    // Operator points site B's redirect at the corrected destination anyway.
    await api(app, ops, "POST", "/api/redirects", {
      slug: "hl/market",
      target: "https://fest.example/sun",
    });

    // Evaluate: still REPRINT — the ink itself is wrong (INV-02).
    const evalRes = await api(app, agent, "POST", `/api/campaigns/${cid}/plans/evaluate`);
    const b = evalRes.json.results.find((r: any) => r.siteCode === "B");
    assert.equal(b.state, "REPRINT");
    assert.match(b.reason, /ink/);

    // Even a "successful" scan cannot verify it — re-evaluate stays REPRINT.
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

    // Scan endpoint refuses to verify while the registry disagrees.
    await api(app, ops, "POST", "/api/redirects", {
      slug: "hl/market",
      target: "https://fest.example/stale",
    });
    // Put a redirect-check item in place to exercise scan disagreement:
    // site C is web-only.
    const siteC = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
      siteCode: "C",
      siteLabel: "Pier kiosk",
      format: "A2",
      managedRedirect: true,
      redirectSlug: "hl/market",
      inkFields: [],
      observedRevisionId: revA.json.id,
    });
    const eval3 = await api(app, agent, "POST", `/api/campaigns/${cid}/plans/evaluate`);
    const cItem = eval3.json.results.find((r: any) => r.siteCode === "C");
    assert.equal(cItem.state, "REDIRECT_CHECK");
    const disagree = await api(
      app,
      ACTORS.coordinator.id,
      "POST",
      `/api/campaigns/${cid}/plan-items/${siteC.json.planItem.id}/scan`,
      { resolvedTarget: "https://fest.example/sun" }
    );
    assert.equal(disagree.status, 409);
    assert.match(disagree.json.error.message, /second check/);

    void itemB;
  } finally {
    await app.close();
  }
});
