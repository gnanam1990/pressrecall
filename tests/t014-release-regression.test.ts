import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, pipeline, ACTORS } from "./helpers.js";

/**
 * T-014 — Release regression coverage:
 *  - the public bundle is a persisted snapshot: state changes after
 *    publication must NOT alter what was shared with the client;
 *  - an empty campaign cannot be released (no VERIFIED on nothing);
 *  - unresolved sites require explicit exception signoff.
 */
test("T-014: public bundle is an immutable snapshot; empty campaign and signoff guarded", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const coord = ACTORS.coordinator.id;
  const printer = ACTORS.printerA.id;
  try {
    // --- fully verified campaign → VERIFIED release ---
    const p = await pipeline(app, { settle: true, priceAtoms: 41000 });
    await api(app, printer, "POST", `/api/order-intents/${p.intentId}/accept`);
    await api(app, printer, "POST", `/api/order-intents/${p.intentId}/deliveries`, {
      placementId: p.pid, qty: 1, revisionId: p.revB.id, clientKey: "d1",
    });
    await api(app, coord, "POST", `/api/campaigns/${p.cid}/placements/${p.pid}/evidence`, {
      clientKey: "ev-ok",
      assetText: "PHOTO installed",
      revisionDigestSeen: p.revB.assetDigest,
    });
    const rel = await api(app, buyer, "POST", `/api/campaigns/${p.cid}/release`);
    assert.equal(rel.status, 201);
    assert.equal(rel.json.status, "VERIFIED");
    assert.equal(rel.json.report.state, "VERIFIED", "snapshot carries post-transition status");

    const pubUrl = `${app.url}${rel.json.publicUrl}`;
    const snap1 = (await (await fetch(pubUrl)).json()) as any;
    assert.equal(snap1.status, "VERIFIED");
    assert.equal(snap1.counts.sitesVerified, 1);

    // --- mutate state after publication: wrong-revision evidence reopens
    // the site and a second intent is created against the same campaign ---
    await api(app, coord, "POST", `/api/campaigns/${p.cid}/placements/${p.pid}/evidence`, {
      clientKey: "ev-bad",
      assetText: "PHOTO tampered",
      revisionDigestSeen: "not-the-target-digest",
    });
    const live = await api(app, buyer, "GET", `/api/campaigns/${p.cid}/report`);
    assert.equal(live.json.counts.sitesVerified, 0, "live report reflects the reopened site");

    // --- replay: the public bundle must be the frozen snapshot ---
    const snap2 = (await (await fetch(pubUrl)).json()) as any;
    assert.deepEqual(snap2, snap1, "public bundle is immutable after publication");

    // --- empty campaign cannot release ---
    const empty = await api(app, buyer, "POST", "/api/campaigns", {
      name: "Empty", budgetCapAtoms: 1000,
    });
    const relEmpty = await api(
      app, buyer, "POST", `/api/campaigns/${empty.json.id}/release`
    );
    assert.equal(relEmpty.status, 409, "no VERIFIED on an empty campaign");

    // --- unresolved site requires explicit exception signoff ---
    const un = await pipeline(app, { priceAtoms: 44000 }); // no evidence → unresolved
    const refused = await api(app, buyer, "POST", `/api/campaigns/${un.cid}/release`);
    assert.equal(refused.status, 409, "unresolved site refuses release without signoff");
    const signed = await api(app, buyer, "POST", `/api/campaigns/${un.cid}/release`, {
      allowExceptions: true,
    });
    assert.equal(signed.status, 201);
    assert.equal(signed.json.status, "CLOSED_WITH_EXCEPTIONS");
    assert.equal(signed.json.report.state, "CLOSED_WITH_EXCEPTIONS");
  } finally {
    await app.close();
  }
});
