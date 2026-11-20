import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS } from "./helpers.js";

/**
 * T-003 — Placement decision — Normal workflow
 * Correct the managed destination at site A and verify a fresh scan closes
 * its web-only task at zero spend.
 */
test("T-003: corrected managed destination + fresh scan closes web-only task at zero spend", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const agent = ACTORS.agent.id;
  const ops = ACTORS.operator.id;

  try {
    const c = await api(app, buyer, "POST", "/api/campaigns", { name: "Fest" });
    const cid = c.json.id;

    // revA: Saturday in ink + old managed destination.
    const revA = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "poster-v1",
      body: { eventDateText: "Saturday June 6" },
      redirectTarget: "https://fest.example/sat",
    });
    // revB: Sunday in ink + corrected destination (change class both).
    const revB = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "poster-v2",
      body: { eventDateText: "Sunday June 7" },
      redirectTarget: "https://fest.example/sun",
      parentId: revA.json.id,
    });
    assert.equal(revB.json.changeClass, "both");

    // Site A: no date in ink ("check current dates online"), QR managed.
    const siteA = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
      siteCode: "A",
      siteLabel: "Ferry Building kiosk",
      format: "A2",
      managedRedirect: true,
      redirectSlug: "hl/ferry",
      inkFields: [],
      observedRevisionId: revA.json.id,
    });
    const itemA = siteA.json.planItem.id;

    // Operator registry still resolves to the Saturday destination.
    await api(app, ops, "POST", "/api/redirects", {
      slug: "hl/ferry",
      target: "https://fest.example/sat",
    });

    // Agent evaluates: site A is a web-only redirect check.
    const evalRes = await api(app, agent, "POST", `/api/campaigns/${cid}/plans/evaluate`);
    assert.equal(evalRes.status, 200);
    const a = evalRes.json.results.find((r: any) => r.siteCode === "A");
    assert.equal(a.state, "REDIRECT_CHECK");

    // Operator corrects the managed destination.
    await api(app, ops, "POST", "/api/redirects", {
      slug: "hl/ferry",
      target: "https://fest.example/sun",
    });

    // Fresh scan confirms the deployed destination → VERIFIED, zero spend.
    const scan = await api(
      app,
      ACTORS.coordinator.id,
      "POST",
      `/api/campaigns/${cid}/plan-items/${itemA}/scan`,
      { resolvedTarget: "https://fest.example/sun" }
    );
    assert.equal(scan.status, 200);
    assert.equal(scan.json.state, "VERIFIED");
    assert.equal(scan.json.decidedBy, ACTORS.coordinator.id);
    assert.equal(scan.json.evidence.resolvedTarget, "https://fest.example/sun");
    assert.equal(scan.json.evidence.approvedTarget, "https://fest.example/sun");

    // Zero spend: no spend/order events were emitted for this campaign.
    const spendEvents = app.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE campaign_id = ? AND (type LIKE 'spend%' OR type LIKE 'order%')"
      )
      .get(cid) as { n: number };
    assert.equal(spendEvents.n, 0);
  } finally {
    await app.close();
  }
});
