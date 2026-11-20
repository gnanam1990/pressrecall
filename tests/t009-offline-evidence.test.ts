import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, ACTORS } from "./helpers.js";

/**
 * T-009 — A duplicate offline evidence upload reconnects to exactly one
 * attachment and one current installation; the dedupe survives a server
 * restart (durable clientKey).
 */
test("T-009: offline evidence retry dedupes across reconnect + restart", async () => {
  const app = await startApp();
  const buyer = ACTORS.buyer.id;
  const coord = ACTORS.coordinator.id;
  try {
    const c = await api(app, buyer, "POST", "/api/campaigns", { name: "Fest" });
    const cid = c.json.id;
    const rev = await api(app, buyer, "POST", `/api/campaigns/${cid}/revisions`, {
      assetText: "v2",
      body: { eventDateText: "Sunday June 7" },
    });
    const site = await api(app, buyer, "POST", `/api/campaigns/${cid}/placements`, {
      siteCode: "B",
      siteLabel: "Market St",
      format: "A2",
      inkFields: ["eventDateText"],
    });
    const pid = site.json.id;

    // First upload — offline field client.
    const up1 = await api(app, coord, "POST", `/api/campaigns/${cid}/placements/${pid}/evidence`, {
      clientKey: "offline-key-7",
      assetText: "PHOTO: corrected poster at Market St",
      revisionDigestSeen: rev.json.assetDigest,
      capturedAt: "2026-06-01T10:00:00.000Z",
    });
    assert.equal(up1.status, 201);
    assert.equal(up1.json.installation.status, "CURRENT");

    // Duplicate retry on reconnect — same clientKey + payload → original.
    const up2 = await api(app, coord, "POST", `/api/campaigns/${cid}/placements/${pid}/evidence`, {
      clientKey: "offline-key-7",
      assetText: "PHOTO: corrected poster at Market St",
      revisionDigestSeen: rev.json.assetDigest,
      capturedAt: "2026-06-01T10:00:00.000Z",
    });
    assert.equal(up2.status, 200);
    assert.equal(up2.json.id, up1.json.id);

    // Same key, different payload → conflict, not a second attachment.
    const changed = await api(app, coord, "POST", `/api/campaigns/${cid}/placements/${pid}/evidence`, {
      clientKey: "offline-key-7",
      assetText: "DIFFERENT photo",
    });
    assert.equal(changed.status, 409);

    const list = await api(app, buyer, "GET", `/api/campaigns/${cid}/placements/${pid}/evidence`);
    assert.equal(list.json.evidence.length, 1);

    await app.close();

    // Restart the API against the same durable DB.
    const app2 = await startApp({ dbPath: app.dbPath, varDir: app.varDir });
    const up3 = await api(app2, coord, "POST", `/api/campaigns/${cid}/placements/${pid}/evidence`, {
      clientKey: "offline-key-7",
      assetText: "PHOTO: corrected poster at Market St",
      revisionDigestSeen: rev.json.assetDigest,
      capturedAt: "2026-06-01T10:00:00.000Z",
    });
    assert.equal(up3.status, 200);
    assert.equal(up3.json.id, up1.json.id);
    const list2 = await api(app2, buyer, "GET", `/api/campaigns/${cid}/placements/${pid}/evidence`);
    assert.equal(list2.json.evidence.length, 1, "still exactly one attachment after restart");
    const plc = await api(app2, buyer, "GET", `/api/campaigns/${cid}/placements/${pid}`);
    assert.equal(plc.json.installation.status, "CURRENT");
    await app2.close();
  } catch (err) {
    await app.close().catch(() => {});
    throw err;
  }
});
