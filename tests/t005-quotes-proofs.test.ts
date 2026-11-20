import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS } from "./helpers.js";

/**
 * T-005 — Quotes and proofs — Normal workflow
 * Two shops quote different quantities; verify the accepted proof displays
 * the selected quantity, payee and total.
 */
test("T-005: competing shop quotes; approved bound proof shows selected qty, payee, total", async () => {
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
      siteLabel: "Market St shelter",
      format: "A2",
      inkFields: ["eventDateText"],
      observedRevisionId: revA.json.id,
    });
    const itemId = site.json.planItem.id;

    // Agent solicits a scoped quote for the reprint.
    const rfq = await api(app, ACTORS.agent.id, "POST", `/api/campaigns/${cid}/quote-requests`, {
      planItemId: itemId,
      revisionId: revB.json.id,
      dimensions: "594x841mm",
      deadline: "2026-12-03",
      qty: 1,
    });
    assert.equal(rfq.status, 201);
    const qrid = rfq.json.id;

    // Two shops quote different quantities and prices.
    const future = "2099-01-01T00:00:00.000Z";
    const qA = await api(app, ACTORS.printerA.id, "POST", `/api/printer/quote-requests/${qrid}/quotes`, {
      qty: 1,
      priceAtoms: 42000,
      token: "USD",
      network: "SANDBOX",
      recipient: "acct_printer_a",
      expiresAt: future,
    });
    assert.equal(qA.status, 201);
    const qB = await api(app, ACTORS.printerB.id, "POST", `/api/printer/quote-requests/${qrid}/quotes`, {
      qty: 2,
      priceAtoms: 75000,
      token: "USD",
      network: "SANDBOX",
      recipient: "acct_printer_b",
      expiresAt: future,
    });
    assert.equal(qB.status, 201);
    assert.notEqual(qA.json.quoteHash, qB.json.quoteHash);

    // Buyer sees both quotes on the campaign.
    const list = await api(app, buyer, "GET", `/api/campaigns/${cid}/quotes`);
    assert.equal(list.json.quotes.length, 2);

    // Printer A uploads the proof for the revised artwork.
    const proof = await api(
      app,
      ACTORS.printerA.id,
      "POST",
      `/api/printer/quote-requests/${qrid}/proofs`,
      { assetText: "PROOF — Harborlight — Sunday June 7 — A2" }
    );
    assert.equal(proof.status, 201);

    // Buyer approves shop A's quote + bound proof.
    const appr = await api(app, buyer, "POST", `/api/campaigns/${cid}/approvals`, {
      quoteId: qA.json.id,
      proofId: proof.json.id,
    });
    assert.equal(appr.status, 201);
    assert.equal(appr.json.selected.qty, 1);
    assert.equal(appr.json.selected.recipient, "acct_printer_a");
    assert.equal(appr.json.budgetAtoms, 42000);
    assert.equal(appr.json.selected.token, "USD");
    assert.equal(appr.json.quoteHash, qA.json.quoteHash);
    assert.equal(appr.json.proofHash, proof.json.proofDigest);

    // Printers cannot approve; shop B cannot see shop A's quotes list route.
    const denied = await api(app, ACTORS.printerA.id, "POST", `/api/campaigns/${cid}/approvals`, {
      quoteId: qA.json.id,
      proofId: proof.json.id,
    });
    assert.equal(denied.status, 403);
    const bSeesOwn = await api(app, ACTORS.printerB.id, "GET", "/api/printer/quotes");
    assert.equal(bSeesOwn.json.quotes.length, 1);
    assert.equal(bSeesOwn.json.quotes[0].printerId, "prn_b");
  } finally {
    await app.close();
  }
});
