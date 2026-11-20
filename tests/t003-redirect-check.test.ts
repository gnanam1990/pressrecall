import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, startRedirectServer, api, ACTORS } from "./helpers.js";

/**
 * T-003 — Placement decision — Normal workflow
 * Correct the managed destination at site A and verify a fresh scan closes
 * its web-only task at zero spend.
 *
 * Review requirement: VERIFIED observes the actually deployed redirect over
 * real HTTP (an independent operator redirect service), not just the
 * intended registry mapping.
 */
test("T-003: deployed redirect observed over HTTP closes web-only task at zero spend", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const agent = ACTORS.agent.id;
  const ops = ACTORS.operator.id;

  // Independent operator redirect service — what the installed QR serves.
  const redirector = await startRedirectServer("https://fest.example/sat");

  try {
    const c = await api(app, buyer, "POST", "/api/campaigns", { name: "Fest" });
    const cid = c.json.id;

    const revA = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "poster-v1",
      body: { eventDateText: "Saturday June 6" },
      redirectTarget: "https://fest.example/sat",
    });
    const revB = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "poster-v2",
      body: { eventDateText: "Sunday June 7" },
      redirectTarget: "https://fest.example/sun",
      parentId: revA.json.id,
    });
    assert.equal(revB.json.changeClass, "both");

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

    // Registry binds the slug to the deployed managed URL (the QR target).
    await api(app, ops, "POST", "/api/redirects", {
      slug: "hl/ferry",
      target: "https://fest.example/sat",
      managedUrl: `${redirector.url}/hl/ferry`,
    });

    // Evaluate: live resolution shows the deployed redirect still stale.
    const evalRes = await api(app, agent, "POST", `/api/campaigns/${cid}/plans/evaluate`);
    const a = evalRes.json.results.find((r: any) => r.siteCode === "A");
    assert.equal(a.state, "REDIRECT_CHECK");

    // Operator records the intended correction in the registry — but the
    // deployed service still serves Saturday. Registry alone proves intent,
    // not what the QR serves.
    await api(app, ops, "POST", "/api/redirects", {
      slug: "hl/ferry",
      target: "https://fest.example/sun",
    });
    const premature = await api(
      app,
      ACTORS.coordinator.id,
      "POST",
      `/api/campaigns/${cid}/plan-items/${itemA}/scan`
    );
    assert.equal(premature.json.state, "REDIRECT_CHECK");
    assert.equal(premature.json.evidence.location, "https://fest.example/sat");
    assert.match(premature.json.reason, /not the approved target/);

    // Operator deploys the correction; a fresh scan observes it → VERIFIED.
    redirector.setLocation("https://fest.example/sun");
    const scan = await api(
      app,
      ACTORS.coordinator.id,
      "POST",
      `/api/campaigns/${cid}/plan-items/${itemA}/scan`
    );
    assert.equal(scan.status, 200);
    assert.equal(scan.json.state, "VERIFIED");
    assert.equal(scan.json.decidedBy, ACTORS.coordinator.id);
    assert.equal(scan.json.evidence.method, "http");
    assert.equal(scan.json.evidence.location, "https://fest.example/sun");
    assert.equal(scan.json.evidence.approvedTarget, "https://fest.example/sun");
    assert.equal(scan.json.evidence.managedUrl, `${redirector.url}/hl/ferry`);
    assert.equal(scan.json.evidence.httpStatus, 302);

    // Zero spend: no spend/order events were emitted for this campaign.
    const spendEvents = app.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE campaign_id = ? AND (type LIKE 'spend%' OR type LIKE 'order%')"
      )
      .get(cid) as { n: number };
    assert.equal(spendEvents.n, 0);
  } finally {
    await redirector.close();
    await app.close();
  }
});

test("T-003b: out-of-policy managed URL cannot be resolved; manual scan stays unverified", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const ops = ACTORS.operator.id;
  const agent = ACTORS.agent.id;

  try {
    const c = await api(app, buyer, "POST", "/api/campaigns", { name: "Fest2" });
    const cid = c.json.id;
    const revA = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "p1",
      body: {},
      redirectTarget: "https://x.example/old",
    });
    await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "p2",
      body: {},
      redirectTarget: "https://x.example/new",
      parentId: revA.json.id,
    });
    const site = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
      siteCode: "D",
      siteLabel: "Out-of-policy wall",
      format: "A2",
      managedRedirect: true,
      redirectSlug: "hl/denied",
      inkFields: [],
      observedRevisionId: revA.json.id,
    });
    const itemId = site.json.planItem.id;

    // Managed URL on a host outside the allowlist — fetch must be refused.
    await api(app, ops, "POST", "/api/redirects", {
      slug: "hl/denied",
      target: "https://x.example/new",
      managedUrl: "http://169.254.169.254/r",
    });
    const scan = await api(
      app,
      agent,
      "POST",
      `/api/campaigns/${cid}/plan-items/${itemId}/scan`
    );
    assert.equal(scan.json.state, "REDIRECT_CHECK");
    assert.match(scan.json.evidence.error, /allowlist/);
    assert.match(scan.json.reason, /resolution failed/);

    // Manual field observation is retained but explicitly UNVERIFIED.
    const manual = await api(
      app,
      ACTORS.coordinator.id,
      "POST",
      `/api/campaigns/${cid}/plan-items/${itemId}/scan`,
      { manualLocation: "https://x.example/new", note: "field QR scan" }
    );
    assert.equal(manual.json.state, "REDIRECT_CHECK");
    assert.equal(manual.json.evidence.method, "manual");
    assert.equal(manual.json.evidence.verified, false);
    assert.equal(manual.json.evidence.reportedLocation, "https://x.example/new");
    assert.match(manual.json.reason, /UNVERIFIED/);
  } finally {
    await app.close();
  }
});
