import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, pipeline, ACTORS } from "./helpers.js";

/**
 * T-011 — An accepted job carried from revision through installation
 * produces an acceptance release whose payment verification independently
 * matches the settled receipt, re-exported from a fresh request.
 */
test("T-011: revision→paid job→installed evidence→release export matches payment", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const printer = ACTORS.printerA.id;
  const coord = ACTORS.coordinator.id;
  try {
    const p = await pipeline(app, { settle: true });
    assert.equal(p.spend.status, "CONFIRMED");

    await api(app, printer, "POST", `/api/order-intents/${p.intentId}/accept`);
    const dly = await api(app, printer, "POST", `/api/order-intents/${p.intentId}/deliveries`, {
      placementId: p.pid,
      qty: 1,
      revisionId: p.revB.id,
      clientKey: "dly-t11",
    });
    assert.equal(dly.status, 201);
    const ev = await api(app, coord, "POST", `/api/campaigns/${p.cid}/placements/${p.pid}/evidence`, {
      clientKey: "ev-t11",
      assetText: "PHOTO: corrected poster installed",
      revisionDigestSeen: p.revB.assetDigest,
    });
    assert.equal(ev.json.installation.status, "CURRENT");

    // Release.
    const rel = await api(app, buyer, "POST", `/api/campaigns/${p.cid}/release`);
    assert.equal(rel.status, 201, JSON.stringify(rel.json));
    assert.equal(rel.json.status, "VERIFIED");

    const report = rel.json.report;
    assert.equal(report.counts.sitesTotal, 1);
    assert.equal(report.counts.sitesVerified, 1);
    assert.equal(report.counts.spendsConfirmed, 1);
    assert.equal(report.costs.settledAtoms, 42000);
    assert.equal(report.attribution.teamFundedAtoms, 42000);
    assert.equal(report.attribution.independentAtoms, 0);
    assert.deepEqual(report.unresolved, []);

    // Payment verification is re-derived from receipts, not the flag.
    const pay = report.costs.payments[0];
    assert.equal(pay.receiptMatched, true);
    assert.equal(pay.txHash, p.spend.txHash);
    assert.equal(pay.amountAtoms, 42000);
    assert.equal(pay.recipient, "acct_printer_a");
    assert.equal(pay.ledger, "SANDBOX");

    // Fresh request (new token) returns the same private report and the
    // shareable public bundle independently of auth.
    const fresh = await api(app, ACTORS.agent.id, "GET", `/api/campaigns/${p.cid}/report`);
    assert.equal(fresh.json.costs.settledAtoms, 42000);
    assert.equal(fresh.json.costs.payments[0].txHash, p.spend.txHash);

    const pub = await fetch(`${app.url}${rel.json.publicUrl}`);
    assert.equal(pub.status, 200);
    const bundle = (await pub.json()) as any;
    assert.equal(bundle.state, "VERIFIED");
    assert.equal(bundle.costs.settledAtoms, 42000);
    assert.equal(bundle.sites[0].siteCode, "B");
  } finally {
    await app.close();
  }
});
