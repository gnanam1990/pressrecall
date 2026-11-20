import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS } from "./helpers.js";

/**
 * T-006 — Quotes and proofs — Failure and recovery
 * Race quote expiry or change the proof after approval; no spend intent
 * becomes eligible (INV-03).
 */
test("T-006: expired quote and post-approval proof change make intents ineligible", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;

  try {
    const c = await api(app, buyer, "POST", "/api/campaigns", { name: "Fest" });
    const cid = c.json.id;
    const revA = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "v1",
      body: { eventDateText: "Saturday June 6" },
    });
    const revB = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "v2",
      body: { eventDateText: "Sunday June 7" },
      parentId: revA.json.id,
    });
    const site = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
      siteCode: "B",
      siteLabel: "Wall",
      format: "A2",
      inkFields: ["eventDateText"],
      observedRevisionId: revA.json.id,
    });

    // --- Case 1: expired quote can never be approved ---
    const rfq1 = await api(app, ACTORS.agent.id, "POST", `/api/campaigns/${cid}/quote-requests`, {
      planItemId: site.json.planItem.id,
      revisionId: revB.json.id,
      dimensions: "594x841mm",
    });
    const qExpired = await api(app, ACTORS.printerA.id, "POST", `/api/printer/quote-requests/${rfq1.json.id}/quotes`, {
      qty: 1,
      priceAtoms: 1000,
      token: "USD",
      recipient: "acct_printer_a",
      expiresAt: "2020-01-01T00:00:00.000Z", // already expired at submission
    });
    assert.equal(qExpired.status, 201);
    const pExpired = await api(app, ACTORS.printerA.id, "POST", `/api/printer/quote-requests/${rfq1.json.id}/proofs`, {
      assetText: "proof-expired",
    });
    const apprExpired = await api(app, buyer, "POST", `/api/campaigns/${cid}/approvals`, {
      quoteId: qExpired.json.id,
      proofId: pExpired.json.id,
    });
    assert.equal(apprExpired.status, 409);
    assert.match(apprExpired.json.error.message, /expired/);

    // --- Case 2: proof changed after approval → intent ineligible ---
    const rfq2 = await api(app, ACTORS.agent.id, "POST", `/api/campaigns/${cid}/quote-requests`, {
      planItemId: site.json.planItem.id,
      revisionId: revB.json.id,
      dimensions: "594x841mm",
    });
    const qOk = await api(app, ACTORS.printerB.id, "POST", `/api/printer/quote-requests/${rfq2.json.id}/quotes`, {
      qty: 1,
      priceAtoms: 50000,
      token: "USD",
      recipient: "acct_printer_b",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const proofV1 = await api(app, ACTORS.printerB.id, "POST", `/api/printer/quote-requests/${rfq2.json.id}/proofs`, {
      assetText: "PROOF v1 Sunday",
    });
    const appr = await api(app, buyer, "POST", `/api/campaigns/${cid}/approvals`, {
      quoteId: qOk.json.id,
      proofId: proofV1.json.id,
    });
    assert.equal(appr.status, 201);

    // Verify currently eligible.
    const list1 = await api(app, buyer, "GET", `/api/campaigns/${cid}/approvals`);
    const a1 = list1.json.approvals.find((x: any) => x.id === appr.json.id);
    assert.equal(a1.eligibility.eligible, true);

    // Shop uploads a different proof for the same job after approval.
    await api(app, ACTORS.printerB.id, "POST", `/api/printer/quote-requests/${rfq2.json.id}/proofs`, {
      assetText: "PROOF v2 SUNDAY (edited)",
    });
    const list2 = await api(app, buyer, "GET", `/api/campaigns/${cid}/approvals`);
    const a2 = list2.json.approvals.find((x: any) => x.id === appr.json.id);
    assert.equal(a2.eligibility.eligible, false);
    assert.match(a2.eligibility.reason, /proof changed/);

    // New proof + re-approval supersedes the stale approval.
    const proofs = app.db
      .prepare("SELECT id FROM proofs WHERE quote_request_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(rfq2.json.id) as { id: string };
    const appr2 = await api(app, buyer, "POST", `/api/campaigns/${cid}/approvals`, {
      quoteId: qOk.json.id,
      proofId: proofs.id,
    });
    assert.equal(appr2.status, 201);
    const list3 = await api(app, buyer, "GET", `/api/campaigns/${cid}/approvals`);
    const old = list3.json.approvals.find((x: any) => x.id === appr.json.id);
    assert.equal(old.supersededBy, appr2.json.id);
    assert.equal(old.eligibility.eligible, false);
    const fresh = list3.json.approvals.find((x: any) => x.id === appr2.json.id);
    assert.equal(fresh.eligibility.eligible, true);
  } finally {
    await app.close();
  }
});
