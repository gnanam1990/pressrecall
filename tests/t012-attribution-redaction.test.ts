import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, pipeline, ACTORS } from "./helpers.js";

/**
 * T-012 — Attribution is ledger-aware: sandbox spends never prove
 * independent use (a fundedBy label alone is claimed, not evidence), and
 * the public bundle strips EXIF/contact/private fields.
 */
test("T-012: sandbox attribution is claimed not proven; public bundle is redacted", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const coord = ACTORS.coordinator.id;
  try {
    // One spend funded by the external grantor, one by the team. Prices
    // differ so the canonical quote hashes are distinct.
    const ext = await pipeline(app, { settle: true, fundedBy: "external", priceAtoms: 42000 });
    const team = await pipeline(app, { settle: true, priceAtoms: 43000 }); // default fundedBy team

    // Attach evidence containing EXIF-like metadata and a contact note.
    await api(app, ACTORS.printerA.id, "POST", `/api/order-intents/${ext.intentId}/accept`);
    await api(app, ACTORS.printerA.id, "POST", `/api/order-intents/${ext.intentId}/deliveries`, {
      placementId: ext.pid, qty: 1, revisionId: ext.revB.id, clientKey: "d1",
    });
    const ev = await api(app, coord, "POST", `/api/campaigns/${ext.cid}/placements/${ext.pid}/evidence`, {
      clientKey: "ev-exif",
      assetText: "PHOTO with EXIF GPS 45.4215,-75.6972 CAMERA=Phone12",
      revisionDigestSeen: ext.revB.assetDigest,
      note: "EXIF GPS 45.4215,-75.6972 — call Sam at 555-0100",
    });
    assert.equal(ev.status, 201);
    await api(app, ACTORS.printerA.id, "POST", `/api/order-intents/${team.intentId}/accept`);
    await api(app, ACTORS.printerA.id, "POST", `/api/order-intents/${team.intentId}/deliveries`, {
      placementId: team.pid, qty: 1, revisionId: team.revB.id, clientKey: "d2",
    });
    await api(app, coord, "POST", `/api/campaigns/${team.cid}/placements/${team.pid}/evidence`, {
      clientKey: "ev-team",
      assetText: "PHOTO correct",
      revisionDigestSeen: team.revB.assetDigest,
    });

    const relExt = await api(app, buyer, "POST", `/api/campaigns/${ext.cid}/release`);
    assert.equal(relExt.status, 201);
    const r = relExt.json.report;
    // The spend carried fundedBy 'external' but settled on the SANDBOX
    // ledger — a buyer label cannot prove independent use.
    assert.equal(r.attribution.independentAtoms, 0);
    assert.equal(r.attribution.claimedIndependentAtoms, 42000);
    assert.equal(r.attribution.teamFundedAtoms, 0);
    assert.equal(r.attribution.evidenceClass, "SANDBOX_ONLY");
    assert.equal(r.costs.sandboxSettledAtoms, 42000);
    assert.equal(r.costs.liveSettledAtoms, 0);

    const relTeam = await api(app, buyer, "POST", `/api/campaigns/${team.cid}/release`);
    assert.equal(relTeam.json.report.attribution.independentAtoms, 0);
    assert.equal(relTeam.json.report.attribution.claimedIndependentAtoms, 0);
    assert.equal(relTeam.json.report.attribution.teamFundedAtoms, 43000);
    assert.equal(relTeam.json.report.attribution.evidenceClass, "SANDBOX_ONLY");

    // Public bundle must not contain EXIF, notes, labels, contacts or
    // uploader identities — only digests, codes, states, aggregates.
    const pubRes = await fetch(`${app.url}${relExt.json.publicUrl}`);
    const pub = (await pubRes.json()) as any;
    const serialized = JSON.stringify(pub);
    assert.ok(!serialized.includes("GPS"), "no EXIF in public bundle");
    assert.ok(!serialized.includes("555-0100"), "no contact phone in public bundle");
    assert.ok(!serialized.includes("Market St"), "no site label in public bundle");
    assert.ok(!serialized.includes("act_coord"), "no uploader id in public bundle");
    assert.ok(!serialized.includes("acct_printer_a"), "no raw payee in public bundle");
    assert.ok(!serialized.includes("sess_"), "no session id in public bundle");
    assert.equal(pub.sites[0].siteLabel, undefined);
    assert.ok(pub.sites[0].targetDigest, "digests remain for independent matching");

    // Private report retains audit detail for the buyer.
    const priv = await api(app, buyer, "GET", `/api/campaigns/${ext.cid}/report`);
    assert.equal(priv.json.sites[0].siteLabel, "Market St");
    assert.equal(priv.json.costs.payments[0].recipient, "acct_printer_a");

    // And the redacted export refuses nothing to strangers without the token.
    const wrong = await fetch(`${app.url}/api/release/pub_nonexistent`);
    assert.equal(wrong.status, 404);
  } finally {
    await app.close();
  }
});
