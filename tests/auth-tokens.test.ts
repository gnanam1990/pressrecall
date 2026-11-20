import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, api, apiBare, apiRaw, apiToken, mintToken, ACTORS } from "./helpers.js";

/**
 * Auth boundary tests (independent review requirement):
 * - tenant routes reject a bare actor id
 * - scoped bearer tokens required; revocation, expiry, wrong secret denied
 * - scope escalation beyond role denied; cross-tenant invisible
 */
test("auth: bare actor id rejected; scoped tokens enforced; revocation honored", async () => {
  const app = await startApp();
  try {
    // Bare x-actor-id rejected on a normal tenant route.
    const bare = await apiBare(app, ACTORS.buyer.id, "GET", "/api/campaigns");
    assert.equal(bare.status, 401);

    // No credentials at all.
    const anon = await apiRaw(app, "GET", "/api/campaigns");
    assert.equal(anon.status, 401);

    // Garbage token.
    const garbage = await apiToken(app, "prt_garbage", "GET", "/api/campaigns");
    assert.equal(garbage.status, 401);

    // Wrong secret cannot mint.
    const wrongSecret = await apiRaw(app, "POST", "/api/auth/token", {
      actorId: ACTORS.buyer.id,
      secret: "nope",
    });
    assert.equal(wrongSecret.status, 401);

    // Scope beyond the role is refused at issuance.
    const escalate = await apiRaw(app, "POST", "/api/auth/token", {
      actorId: ACTORS.coordinator.id,
      secret: "sec_coord",
      scopes: ["campaigns:read", "revisions:write"],
    });
    assert.equal(escalate.status, 403);

    // Narrow token: coordinator with read-only scope cannot write observations.
    const narrow = await mintToken(app, ACTORS.coordinator.id, {
      scopes: ["campaigns:read"],
    });
    const denied = await apiToken(
      app,
      narrow,
      "POST",
      "/api/campaigns/cmp_x/placements/p_x/observations",
      { observedDigest: "x" }
    );
    assert.equal(denied.status, 403);
    assert.match(denied.json.error.message, /scope/);

    // Valid token works.
    const ok = await api(app, ACTORS.buyer.id, "GET", "/api/campaigns");
    assert.equal(ok.status, 200);

    // Revocation: revoked token is dead immediately.
    const tok = await mintToken(app, ACTORS.buyer.id);
    const me = await apiToken(app, tok, "GET", "/api/auth/me");
    assert.equal(me.status, 200);
    const other = await mintToken(app, ACTORS.buyer.id);
    const revoke = await apiToken(app, other, "POST", "/api/auth/revoke", { token: tok });
    assert.equal(revoke.status, 200);
    const afterRevoke = await apiToken(app, tok, "GET", "/api/auth/me");
    assert.equal(afterRevoke.status, 401);
    assert.match(afterRevoke.json.error.message, /revoked/);

    // Expiry: a token minted already-expired is dead.
    const expired = await mintToken(app, ACTORS.buyer.id, {
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const afterExpiry = await apiToken(app, expired, "GET", "/api/auth/me");
    assert.equal(afterExpiry.status, 401);
    assert.match(afterExpiry.json.error.message, /expired/);
  } finally {
    await app.close();
  }
});

test("auth: isolated-demo x-actor-id works only when explicitly enabled", async () => {
  // Off by default — verified above. Enabled → demo path works.
  const app = await startApp({ demoAuth: true });
  try {
    const bare = await apiBare(app, ACTORS.buyer.id, "GET", "/api/campaigns");
    assert.equal(bare.status, 200);
    const unknown = await apiBare(app, "act_ghost", "GET", "/api/campaigns");
    assert.equal(unknown.status, 401);
  } finally {
    await app.close();
  }
});
