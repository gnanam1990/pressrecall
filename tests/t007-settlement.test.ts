import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS, type TestApp } from "./helpers.js";

const FUTURE = "2099-01-01T00:00:00.000Z";

/** Campaign → revision → placement → quote request → quote → proof → approval. */
async function setupApproval(app: TestApp, priceAtoms = 42000) {
  const buyer = ACTORS.buyer.id;
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
  const rfq = await api(app, ACTORS.agent.id, "POST", `/api/campaigns/${cid}/quote-requests`, {
    planItemId: site.json.planItem.id,
    revisionId: revB.json.id,
    dimensions: "594x841mm",
    deadline: "2026-12-03",
    qty: 1,
  });
  const qrid = rfq.json.id;
  const q = await api(app, ACTORS.printerA.id, "POST", `/api/printer/quote-requests/${qrid}/quotes`, {
    qty: 1,
    priceAtoms,
    token: "USD",
    network: "SANDBOX",
    recipient: "acct_printer_a",
    expiresAt: FUTURE,
  });
  const proof = await api(app, ACTORS.printerA.id, "POST", `/api/printer/quote-requests/${qrid}/proofs`, {
    assetText: "PROOF — revB",
  });
  const appr = await api(app, buyer, "POST", `/api/campaigns/${cid}/approvals`, {
    quoteId: q.json.id,
    proofId: proof.json.id,
  });
  assert.equal(appr.status, 201);
  return { cid, approvalId: appr.json.id };
}

/**
 * T-007 — Approved sandbox settlement reconciles chain/token/recipient/amount,
 * and a later spend under a revoked grant is denied while app credentials
 * stay unchanged.
 */
test("T-007: grant→intent→reserve→execute confirms; revoked grant denies later spend", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const agent = ACTORS.agent.id;
  try {
    const { cid, approvalId } = await setupApproval(app);

    // Human-granted scoped session recorded by the buyer.
    const g = await api(app, buyer, "POST", `/api/campaigns/${cid}/grants`, {
      sessionId: "sess_demo_1",
      maxAmountAtoms: 100000,
      token: "USD",
      network: "SANDBOX",
      allowedPayees: ["acct_printer_a"],
    });
    assert.equal(g.status, 201);
    assert.equal(g.json.status, "ACTIVE");

    // Agent reserves a pending order against the approval (budget held).
    const intent = await api(app, agent, "POST", `/api/campaigns/${cid}/order-intents`, {
      approvalId,
      clientKey: "key-intent-1",
    });
    assert.equal(intent.status, 201);
    assert.equal(intent.json.state, "REQUESTED");
    assert.equal(intent.json.amountAtoms, 42000);

    // Idempotent retry with the same payload returns the original intent.
    const retry = await api(app, agent, "POST", `/api/campaigns/${cid}/order-intents`, {
      approvalId,
      clientKey: "key-intent-1",
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.id, intent.json.id);

    // Shop accepts under its own immutable order reference.
    const reserved = await api(app, ACTORS.printerA.id, "POST", `/api/order-intents/${intent.json.id}/reserve`, {
      shopRef: "SHOP-A-0001",
    });
    assert.equal(reserved.json.state, "RESERVED");

    // Execute the approved payment through the sandbox ledger.
    const spend = await api(app, agent, "POST", `/api/order-intents/${intent.json.id}/execute`);
    assert.equal(spend.status, 200, JSON.stringify(spend.json));
    assert.equal(spend.json.status, "CONFIRMED");
    assert.equal(spend.json.ledger, "SANDBOX");
    assert.match(spend.json.txHash, /^[0-9a-f]{64}$/);

    // Receipt binds chain/token/recipient/exact amount.
    const spends = await api(app, buyer, "GET", `/api/campaigns/${cid}/spends`);
    const rec = spends.json.receipts.find((r: any) => r.spendId === spend.json.id);
    assert.ok(rec, "receipt recorded");
    assert.equal(rec.receipt.network, "SANDBOX");
    assert.equal(rec.receipt.token, "USD");
    assert.equal(rec.receipt.toAccount, "acct_printer_a");
    assert.equal(rec.receipt.amountAtoms, 42000);

    // Revoke the grant — later spend denied with unchanged app credentials.
    const revoke = await api(app, buyer, "POST", `/api/grants/${g.json.id}/revoke`);
    assert.equal(revoke.json.status, "REVOKED");

    const { approvalId: approvalId2 } = await setupApproval2(app, cid);
    const intent2 = await api(app, agent, "POST", `/api/campaigns/${cid}/order-intents`, {
      approvalId: approvalId2,
      clientKey: "key-intent-2",
    });
    assert.equal(intent2.status, 201);
    await api(app, ACTORS.printerA.id, "POST", `/api/order-intents/${intent2.json.id}/reserve`, {
      shopRef: "SHOP-A-0002",
    });
    const denied = await api(app, agent, "POST", `/api/order-intents/${intent2.json.id}/execute`);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, "policy_denied");
  } finally {
    await app.close();
  }
});

/** Second plan item + approval on the same campaign. */
async function setupApproval2(app: TestApp, cid: string, priceAtoms = 50000) {
  const buyer = ACTORS.buyer.id;
  const revs = await api(app, buyer, "GET", `/api/campaigns/${cid}/revisions`);
  const revB = revs.json.revisions[1].id;
  const site = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
    siteCode: "C",
    siteLabel: "Harbor gate",
    format: "A2",
    inkFields: ["eventDateText"],
  });
  const rfq = await api(app, ACTORS.agent.id, "POST", `/api/campaigns/${cid}/quote-requests`, {
    planItemId: site.json.planItem.id,
    revisionId: revB,
    dimensions: "594x841mm",
    deadline: "2026-12-03",
    qty: 1,
  });
  const q = await api(app, ACTORS.printerA.id, "POST", `/api/printer/quote-requests/${rfq.json.id}/quotes`, {
    qty: 1,
    priceAtoms,
    token: "USD",
    network: "SANDBOX",
    recipient: "acct_printer_a",
    expiresAt: FUTURE,
  });
  const proof = await api(app, ACTORS.printerA.id, "POST", `/api/printer/quote-requests/${rfq.json.id}/proofs`, {
    assetText: "PROOF — second",
  });
  const appr = await api(app, buyer, "POST", `/api/campaigns/${cid}/approvals`, {
    quoteId: q.json.id,
    proofId: proof.json.id,
  });
  return { approvalId: appr.json.id };
}

/** T-007b — budget cap and grant scope are enforced. */
test("T-007b: budget cap and payee scope enforced", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const agent = ACTORS.agent.id;
  try {
    const { cid, approvalId } = await setupApproval(app, 42000);

    // Grant scoped to the WRONG payee cannot settle the leg.
    const gWrong = await api(app, buyer, "POST", `/api/campaigns/${cid}/grants`, {
      sessionId: "sess_wrong",
      maxAmountAtoms: 100000,
      token: "USD",
      network: "SANDBOX",
      allowedPayees: ["acct_someone_else"],
    });
    assert.equal(gWrong.status, 201);

    const intent = await api(app, agent, "POST", `/api/campaigns/${cid}/order-intents`, {
      approvalId,
      clientKey: "k1",
    });
    assert.equal(intent.status, 201);
    await api(app, ACTORS.printerA.id, "POST", `/api/order-intents/${intent.json.id}/reserve`, {
      shopRef: "REF-1",
    });
    const denied = await api(app, agent, "POST", `/api/order-intents/${intent.json.id}/execute`);
    assert.equal(denied.status, 403);

    // A correctly-scoped grant settles the same leg.
    await api(app, buyer, "POST", `/api/campaigns/${cid}/grants`, {
      sessionId: "sess_right",
      maxAmountAtoms: 100000,
      token: "USD",
      network: "SANDBOX",
      allowedPayees: ["acct_printer_a"],
    });
    const ok = await api(app, agent, "POST", `/api/order-intents/${intent.json.id}/execute`);
    assert.equal(ok.json.status, "CONFIRMED");

    // An intent that would push committed spend over the cap is refused
    // at reservation time (atomic check).
    const { approvalId: a2 } = await setupApproval2(app, cid, 200000);
    const over = await api(app, agent, "POST", `/api/campaigns/${cid}/order-intents`, {
      approvalId: a2,
      clientKey: "k-over",
    });
    assert.equal(over.status, 409);
    assert.match(over.json.error.message, /budget cap/i);
  } finally {
    await app.close();
  }
});
