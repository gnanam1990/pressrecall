import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS } from "./helpers.js";

/**
 * T-017 — Quote hash uniqueness is per RFQ, not global.
 * quote_hash is the stable commercial hash approvals bind to — but it omits
 * RFQ identity, so identical artwork + identical terms produced the same
 * hash and a globally-unique column rejected a legitimate second quote.
 * Regression: same printer, identical terms, two different RFQs (different
 * campaigns, identical revision digest) must both succeed; an identical
 * re-submit inside one RFQ is still rejected as a duplicate.
 */
test("T-017: identical quote terms allowed across RFQs, rejected within one RFQ", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const agent = ACTORS.agent.id;
  const printer = ACTORS.printerA.id;

  const terms = {
    qty: 1,
    priceAtoms: 42000,
    token: "USD",
    network: "SANDBOX",
    recipient: "acct_printer_a",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  // Identical artwork in two campaigns → identical revision digest.
  const makeRfq = async (name: string) => {
    const c = await api(app, buyer, "POST", "/api/campaigns", { name });
    const cid = c.json.id;
    const revA = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "PRINT v1 · fest poster · June 6",
      body: { eventDateText: "Saturday June 6" },
    });
    const revB = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "PRINT v2 · fest poster · June 7",
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
    const rfq = await api(app, agent, "POST", `/api/campaigns/${cid}/quote-requests`, {
      planItemId: site.json.planItem.id,
      revisionId: revB.json.id,
      dimensions: "594x841mm",
      deadline: "2026-12-03",
      qty: 1,
    });
    assert.equal(rfq.status, 201);
    return { cid, rfqId: rfq.json.id };
  };

  try {
    const campA = await makeRfq("Fest A");
    const campB = await makeRfq("Fest B");

    const qA = await api(app, printer, "POST", `/api/printer/quote-requests/${campA.rfqId}/quotes`, terms);
    assert.equal(qA.status, 201, JSON.stringify(qA.json));

    // Same printer, byte-identical commercial terms, different RFQ — legitimate.
    const qB = await api(app, printer, "POST", `/api/printer/quote-requests/${campB.rfqId}/quotes`, terms);
    assert.equal(qB.status, 201, JSON.stringify(qB.json));
    assert.notEqual(qA.json.id, qB.json.id);
    assert.equal(qA.json.quoteHash, qB.json.quoteHash); // stable commercial hash preserved

    // Identical re-submit inside ONE RFQ is still a duplicate.
    const dupe = await api(app, printer, "POST", `/api/printer/quote-requests/${campA.rfqId}/quotes`, terms);
    assert.equal(dupe.status, 409);

    // Approvals still bind the commercial hash — existing flow unaffected.
    const proof = await api(app, printer, "POST", `/api/printer/quote-requests/${campA.rfqId}/proofs`, {
      assetText: "PROOF — Sunday June 7 — A2",
    });
    assert.equal(proof.status, 201);
    const appr = await api(app, buyer, "POST", `/api/campaigns/${campA.cid}/approvals`, {
      quoteId: qA.json.id,
      proofId: proof.json.id,
    });
    assert.equal(appr.status, 201);
    assert.equal(appr.json.quoteHash, qA.json.quoteHash);
    assert.equal(appr.json.proofHash, proof.json.proofDigest);
  } finally {
    await app.close();
  }
});
