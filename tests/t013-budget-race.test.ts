import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, pipeline, ACTORS } from "./helpers.js";

/**
 * T-013 — Two individually affordable intents (42_000 each under a
 * 50_000 campaign cap) whose sum exceeds the allowance: exactly one
 * reservation succeeds, even when both are submitted concurrently —
 * the check runs inside one serializable transaction.
 */
test("T-013: concurrent intents under aggregate cap — exactly one reserves", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const agent = ACTORS.agent.id;
  const printer = ACTORS.printerA.id;
  try {
    const p = await pipeline(app, { capAtoms: 50000, priceAtoms: 42000, noIntent: true });

    // Second approval for a second site on the same campaign.
    const site2 = await api(app, buyer, "POST", `/api/campaigns/${p.cid}/placements`, {
      siteCode: "C",
      siteLabel: "Harbor gate",
      format: "A2",
      inkFields: ["eventDateText"],
      observedRevisionId: p.revA.id,
    });
    const rfq2 = await api(app, agent, "POST", `/api/campaigns/${p.cid}/quote-requests`, {
      planItemId: site2.json.planItem.id,
      revisionId: p.revB.id,
      dimensions: "594x841mm",
      deadline: "2026-12-03",
      qty: 1,
    });
    const q2 = await api(app, printer, "POST", `/api/printer/quote-requests/${rfq2.json.id}/quotes`, {
      qty: 1,
      priceAtoms: 40000,
      token: "USD",
      network: "SANDBOX",
      recipient: "acct_printer_a",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const proof2 = await api(app, printer, "POST", `/api/printer/quote-requests/${rfq2.json.id}/proofs`, {
      assetText: "PROOF — second site",
    });
    const appr2 = await api(app, buyer, "POST", `/api/campaigns/${p.cid}/approvals`, {
      quoteId: q2.json.id,
      proofId: proof2.json.id,
    });
    assert.equal(appr2.status, 201);

    // Both intents race for the same budget — serializable check admits one.
    const [first, second] = await Promise.all([
      api(app, agent, "POST", `/api/campaigns/${p.cid}/order-intents`, {
        approvalId: p.approvalId,
        clientKey: "race-1",
      }),
      api(app, agent, "POST", `/api/campaigns/${p.cid}/order-intents`, {
        approvalId: appr2.json.id,
        clientKey: "race-2",
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409], JSON.stringify([first.json, second.json]));
    const loser = first.status === 409 ? first : second;
    assert.match(loser.json.error.message, /budget cap/i);

    // Exactly one intent committed; the loser cannot sneak in with a
    // different clientKey either.
    const intents = await api(app, buyer, "GET", `/api/campaigns/${p.cid}/order-intents`);
    assert.equal(intents.json.intents.length, 1);
    assert.ok(intents.json.intents[0].amountAtoms <= 50000);
    const loserApproval =
      first.status === 409 ? p.approvalId : appr2.json.id;
    const retry = await api(app, agent, "POST", `/api/campaigns/${p.cid}/order-intents`, {
      approvalId: loserApproval,
      clientKey: "race-loser-retry",
    });
    assert.equal(retry.status, 409);

    const report = await api(app, buyer, "GET", `/api/campaigns/${p.cid}/report`);
    assert.equal(report.json.counts.intentsTotal, 1);
    assert.equal(report.json.budget.capAtoms, 50000);
    assert.ok(report.json.costs.committedAtoms <= 50000);
  } finally {
    await app.close();
  }
});
