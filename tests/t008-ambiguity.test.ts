import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS, type TestApp } from "./helpers.js";

const FUTURE = "2099-01-01T00:00:00.000Z";

async function setupReserved(app: TestApp): Promise<{ cid: string; intentId: string }> {
  const buyer = ACTORS.buyer.id;
  const c = await api(app, buyer, "POST", "/api/campaigns", { name: "Fest", budgetCapAtoms: 200000 });
  const cid = c.json.id;
  const revA = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
    assetText: "v1",
    body: { eventDateText: "d1" },
  });
  const revB = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
    assetText: "v2",
    body: { eventDateText: "d2" },
    parentId: revA.json.id,
  });
  const site = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
    siteCode: "B",
    siteLabel: "Market St",
    format: "A2",
    inkFields: ["eventDateText"],
    observedRevisionId: revA.json.id,
  });
  const rfq = await api(app, ACTORS.agent.id, "POST", `/api/campaigns/${cid}/quote-requests`, {
    planItemId: site.json.planItem.id,
    revisionId: revB.json.id,
    dimensions: "594x841mm",
    deadline: "2026-12-03",
    qty: 1,
  });
  const q = await api(app, ACTORS.printerA.id, "POST", `/api/printer/quote-requests/${rfq.json.id}/quotes`, {
    qty: 1,
    priceAtoms: 42000,
    token: "USD",
    network: "SANDBOX",
    recipient: "acct_printer_a",
    expiresAt: FUTURE,
  });
  const proof = await api(app, ACTORS.printerA.id, "POST", `/api/printer/quote-requests/${rfq.json.id}/proofs`, {
    assetText: "PROOF",
  });
  const appr = await api(app, buyer, "POST", `/api/campaigns/${cid}/approvals`, {
    quoteId: q.json.id,
    proofId: proof.json.id,
  });
  await api(app, buyer, "POST", `/api/campaigns/${cid}/grants`, {
    sessionId: "sess_1",
    maxAmountAtoms: 100000,
    token: "USD",
    network: "SANDBOX",
    allowedPayees: ["acct_printer_a"],
  });
  const intent = await api(app, ACTORS.agent.id, "POST", `/api/campaigns/${cid}/order-intents`, {
    approvalId: appr.json.id,
    clientKey: "ck-1",
  });
  await api(app, ACTORS.printerA.id, "POST", `/api/order-intents/${intent.json.id}/reserve`, {
    shopRef: "REF-1",
  });
  return { cid, intentId: intent.json.id };
}

/**
 * T-008 — A dropped broadcast response leaves the leg AMBIGUOUS; the same
 * intent cannot allocate a second settlement while uncertainty remains;
 * reconciliation recovers the one receipt without a second charge; a
 * replayed reconcile is idempotent.
 */
test("T-008: dropped broadcast → ambiguous → no double charge → single receipt", async () => {
  const app = await startApp();
  const agent = ACTORS.agent.id;
  const buyer = ACTORS.buyer.id;
  try {
    const { cid, intentId } = await setupReserved(app);

    // Fault injection: the ledger write lands, the response is lost.
    app.chain.dropResponse = true;
    const exec = await api(app, agent, "POST", `/api/order-intents/${intentId}/execute`);
    assert.equal(exec.json.status, "AMBIGUOUS");
    assert.equal(exec.json.txHash, null);

    // INV-04: no second settlement may be allocated while this leg is
    // uncertain — concurrent attempts collapse onto the same frozen leg.
    const [again, concurrent] = await Promise.all([
      api(app, agent, "POST", `/api/order-intents/${intentId}/execute`),
      api(app, buyer, "POST", `/api/order-intents/${intentId}/execute`),
    ]);
    assert.equal(again.status, 409);
    assert.equal(concurrent.status, 409);

    // Reconciliation finds the one real ledger entry via the intent key.
    const rec1 = await api(app, agent, "POST", `/api/spends/${exec.json.id}/reconcile`);
    assert.equal(rec1.json.status, "CONFIRMED");
    assert.match(rec1.json.txHash, /^[0-9a-f]{64}$/);

    // Replay is idempotent — no second cost row.
    const rec2 = await api(app, agent, "POST", `/api/spends/${exec.json.id}/reconcile`);
    assert.equal(rec2.json.status, "CONFIRMED");

    const spends = await api(app, buyer, "GET", `/api/campaigns/${cid}/spends`);
    assert.equal(spends.json.spends.length, 1);
    assert.equal(spends.json.receipts.length, 1);
    const ledger = app.db
      .prepare("SELECT COUNT(*) AS n FROM sandbox_ledger")
      .get() as { n: number };
    assert.equal(ledger.n, 1, "exactly one charge on the ledger");
  } finally {
    await app.close();
  }
});
