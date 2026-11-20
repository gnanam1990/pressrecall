import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS } from "./helpers.js";

/**
 * T-001 — Campaign revisions — Normal workflow
 * Import two sites and one revised PDF, restart the API and retrieve both
 * original observations.
 */
test("T-001: import two sites + revised PDF, restart, observations persist", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;

  // Create campaign with budget cap.
  const c = await api(app, buyer, "POST", "/api/campaigns", {
    name: "Harborlight Festival",
    budgetCapAtoms: 500_000,
    budgetToken: "USD",
  });
  assert.equal(c.status, 201);
  const campaignId = c.json.id;

  // Publish revision A (original print: event Saturday).
  const revA = await api(app, buyer, "POST", `/api/campaigns/${campaignId}/revisions`, {
    assetText: "POSTER v1 — Harborlight — SATURDAY",
    body: { headline: "Harborlight Festival", eventDateText: "Saturday June 6" },
    redirectTarget: "https://fest.example/lineup",
    rightsNote: "rights cleared — internal artwork",
  });
  assert.equal(revA.status, 201);
  assert.equal(revA.json.changeClass, "initial");
  const revAId = revA.json.id;

  // Import two installed sites observed at revision A.
  const siteA = await api(app, buyer, "POST", `/api/campaigns/${campaignId}/placements`, {
    siteCode: "A",
    siteLabel: "Ferry Building kiosk",
    format: "A2",
    managedRedirect: true,
    redirectSlug: "hl/ferry",
    observedRevisionId: revAId,
    deadline: "2026-12-05",
  });
  assert.equal(siteA.status, 201);
  const siteB = await api(app, buyer, "POST", `/api/campaigns/${campaignId}/placements`, {
    siteCode: "B",
    siteLabel: "Market St shelter",
    format: "A2",
    observedRevisionId: revAId,
    deadline: "2026-12-05",
  });
  assert.equal(siteB.status, 201);

  // Publish revision B (date moved to Sunday — ink change).
  const revB = await api(app, buyer, "POST", `/api/campaigns/${campaignId}/revisions`, {
    assetText: "POSTER v2 — Harborlight — SUNDAY",
    body: { headline: "Harborlight Festival", eventDateText: "Sunday June 7" },
    redirectTarget: "https://fest.example/lineup",
    parentId: revAId,
    rightsNote: "rights cleared — internal artwork",
  });
  assert.equal(revB.status, 201);
  assert.equal(revB.json.changeClass, "body");
  assert.equal(revB.json.parentId, revAId);

  // Restart the API against the same database file.
  const dbPath = app.dbPath;
  const varDir = app.varDir;
  await app.close();
  const app2 = await startApp({ dbPath, varDir });
  try {
    const list = await api(
      app2,
      buyer,
      "GET",
      `/api/campaigns/${campaignId}/placements`
    );
    assert.equal(list.status, 200);
    assert.equal(list.json.placements.length, 2);
    const codes = list.json.placements
      .map((p: any) => p.siteCode)
      .sort();
    assert.deepEqual(codes, ["A", "B"]);
    // Both original observations still reference revision A.
    for (const p of list.json.placements) {
      assert.equal(p.observedRevisionId, revAId);
      assert.ok(p.planItem);
      assert.equal(p.planItem.targetRevisionId, revB.json.id);
    }
  } finally {
    await app2.close();
  }
});
