import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS } from "./helpers.js";

/**
 * T-002 — Campaign revisions — Failure and recovery
 * Submit an unknown or cross-campaign version; verify the site remains
 * unverified and the foreign asset is inaccessible.
 */
test("T-002: unknown observed version enters verification queue; foreign assets inaccessible", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;

  const c = await api(app, buyer, "POST", "/api/campaigns", { name: "Fest" });
  const campaignId = c.json.id;
  const revA = await api(app, buyer, "POST", `/api/campaigns/${campaignId}/revisions`, {
    assetText: "A",
    body: { eventDateText: "Saturday June 6" },
  });
  const revAId = revA.json.id;

  // Site with an unknown installed digest → verification queue, not verified.
  const site = await api(app, buyer, "POST", `/api/campaigns/${campaignId}/placements`, {
    siteCode: "U1",
    siteLabel: "Unknown wall",
    format: "A2",
    observedDigest: "deadbeef".repeat(8),
  });
  assert.equal(site.status, 201);
  assert.equal(site.json.planItem.state, "UNKNOWN");
  assert.equal(site.json.observedRevisionId, null);
  assert.equal(site.json.observedRevisionDigest, "deadbeef".repeat(8));

  const queue = await api(app, buyer, "GET", `/api/campaigns/${campaignId}/verification-queue`);
  assert.equal(queue.json.queue.length, 1);
  assert.equal(queue.json.queue[0].siteCode, "U1");

  // Cross-campaign revision reference is rejected.
  const c2 = await api(app, buyer, "POST", "/api/campaigns", { name: "Other campaign" });
  const foreign = await api(app, buyer, "POST", `/api/campaigns/${campaignId}/placements`, {
    siteCode: "X",
    siteLabel: "Bad bind",
    format: "A2",
    observedRevisionId: (await api(app, buyer, "POST", `/api/campaigns/${c2.json.id}/revisions`, {
      assetText: "foreign",
      body: {},
    })).json.id,
  });
  assert.equal(foreign.status, 409);
  assert.match(foreign.json.error.message, /not part of this campaign/);

  // Unknown observation update keeps site unverified.
  const known = await api(app, buyer, "POST", `/api/campaigns/${campaignId}/placements`, {
    siteCode: "K",
    siteLabel: "Known wall",
    format: "A2",
    observedRevisionId: revAId,
  });
  assert.equal(known.json.planItem.state, "OBSERVED");
  const upd = await api(
    app,
    ACTORS.coordinator.id,
    "POST",
    `/api/campaigns/${campaignId}/placements/${known.json.id}/observations`,
    { observedDigest: "cafef00d".repeat(8) }
  );
  assert.equal(upd.status, 200);
  assert.equal(upd.json.planItem.state, "UNKNOWN");

  // Foreign tenant cannot see the campaign or its assets.
  const other = await api(app, ACTORS.buyer2.id, "GET", `/api/campaigns/${campaignId}`);
  assert.equal(other.status, 404);
  const foreignAsset = await api(
    app,
    ACTORS.buyer2.id,
    "GET",
    `/api/campaigns/${campaignId}/revisions/${revAId}/asset`
  );
  assert.equal(foreignAsset.status, 404);

  // Printer role cannot read campaign data at all.
  const asPrinter = await api(app, ACTORS.printerA.id, "GET", `/api/campaigns`);
  assert.equal(asPrinter.status, 403);

  // Declared changeClass that contradicts the computed diff is rejected.
  await api(app, buyer, "POST", `/api/campaigns/${campaignId}/revisions`, {
    assetText: "B",
    body: { eventDateText: "Sunday June 7" },
  });
  const badClass = await api(app, buyer, "POST", `/api/campaigns/${campaignId}/revisions`, {
    assetText: "C",
    body: { eventDateText: "Sunday June 7" },
    changeClass: "body",
  });
  assert.equal(badClass.status, 409);

  await app.close();
});
