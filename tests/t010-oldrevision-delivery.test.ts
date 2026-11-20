import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS } from "./helpers.js";

const FUTURE = "2099-01-01T00:00:00.000Z";

/**
 * T-010 — A delivery of the PREVIOUS revision keeps the site open even
 * though the invoice (spend) is fully settled. Paid ≠ installed.
 */
test("T-010: old-revision delivery + paid spend leaves site open", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const agent = ACTORS.agent.id;
  const printer = ACTORS.printerA.id;
  try {
    const c = await api(app, buyer, "POST", "/api/campaigns", {
      name: "Fest",
      budgetCapAtoms: 200000,
    });
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
      siteLabel: "Market St",
      format: "A2",
      inkFields: ["eventDateText"],
      observedRevisionId: revA.json.id,
    });
    const pid = site.json.id;

    const rfq = await api(app, agent, "POST", `/api/campaigns/${cid}/quote-requests`, {
      planItemId: site.json.planItem.id,
      revisionId: revB.json.id,
      dimensions: "594x841mm",
      deadline: "2026-12-03",
      qty: 1,
    });
    const q = await api(app, printer, "POST", `/api/printer/quote-requests/${rfq.json.id}/quotes`, {
      qty: 1,
      priceAtoms: 42000,
      token: "USD",
      network: "SANDBOX",
      recipient: "acct_printer_a",
      expiresAt: FUTURE,
    });
    const proof = await api(app, printer, "POST", `/api/printer/quote-requests/${rfq.json.id}/proofs`, {
      assetText: "PROOF",
    });
    const appr = await api(app, buyer, "POST", `/api/campaigns/${cid}/approvals`, {
      quoteId: q.json.id,
      proofId: proof.json.id,
    });
    await api(app, buyer, "POST", `/api/campaigns/${cid}/grants`, {
      sessionId: "s1",
      maxAmountAtoms: 100000,
      token: "USD",
      network: "SANDBOX",
      allowedPayees: ["acct_printer_a"],
    });
    const intent = await api(app, agent, "POST", `/api/campaigns/${cid}/order-intents`, {
      approvalId: appr.json.id,
      clientKey: "ck-t10",
    });
    await api(app, printer, "POST", `/api/order-intents/${intent.json.id}/reserve`, { shopRef: "R1" });
    const spend = await api(app, agent, "POST", `/api/order-intents/${intent.json.id}/execute`);
    assert.equal(spend.json.status, "CONFIRMED"); // invoice PAID

    await api(app, printer, "POST", `/api/order-intents/${intent.json.id}/accept`);

    // Shop delivers the OLD revision by mistake.
    const dly = await api(app, printer, "POST", `/api/order-intents/${intent.json.id}/deliveries`, {
      placementId: pid,
      qty: 1,
      revisionId: revA.json.id,
      clientKey: "dly-1",
    });
    assert.equal(dly.status, 201);

    // Site must still be open: delivery revision ≠ target, regardless of
    // the confirmed spend.
    const plc = await api(app, buyer, "GET", `/api/campaigns/${cid}/placements/${pid}`);
    assert.equal(plc.json.planItem.state === "VERIFIED", false);
    assert.notEqual(plc.json.installation.status, "CURRENT");
    assert.equal(plc.json.installation.lastDeliveryRevisionId, revA.json.id);

    // Duplicate delivery retry dedupes.
    const dly2 = await api(app, printer, "POST", `/api/order-intents/${intent.json.id}/deliveries`, {
      placementId: pid,
      qty: 1,
      revisionId: revA.json.id,
      clientKey: "dly-1",
    });
    assert.equal(dly2.status, 200);
    assert.equal(dly2.json.id, dly.json.id);

    // A field photo of the OLD ink still on the wall keeps it open too.
    const ev = await api(app, ACTORS.coordinator.id, "POST", `/api/campaigns/${cid}/placements/${pid}/evidence`, {
      clientKey: "ev-t10",
      assetText: "PHOTO: old date poster",
      revisionDigestSeen: revA.json.assetDigest,
    });
    assert.equal(ev.status, 201);
    assert.notEqual(ev.json.installation.status, "CURRENT");

    // Once the CORRECT install is evidenced, the site closes.
    const ev2 = await api(app, ACTORS.coordinator.id, "POST", `/api/campaigns/${cid}/placements/${pid}/evidence`, {
      clientKey: "ev-t10-b",
      assetText: "PHOTO: new date poster",
      revisionDigestSeen: revB.json.assetDigest,
    });
    assert.equal(ev2.json.installation.status, "CURRENT");
  } finally {
    await app.close();
  }
});
