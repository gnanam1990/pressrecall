import type { Db } from "../db/connection.js";
import type { Actor } from "../http/auth.js";
import { conflict, notFound } from "../domain/errors.js";
import { nowIso } from "../domain/ids.js";
import { canonicalize } from "../domain/canon.js";
import { emit } from "./events.js";
import {
  getCampaign,
  getPlacement,
  getRevision,
  type PlacementRow,
  type PlanItemRow,
  type RevisionRow,
} from "./campaigns.js";

export interface RedirectRow {
  slug: string;
  tenant_id: string;
  current_target: string;
  updated_by: string;
  updated_at: string;
}

export interface Decision {
  state: string;
  reason: string;
}

/**
 * Constrained destination fetcher: resolves a managed redirect slug through
 * the internal operator-controlled registry only — never arbitrary network
 * access. This is the offline honest equivalent of the URL policy check.
 */
export function liveRedirectTarget(db: Db, tenantId: string, slug: string): string | null {
  const row = db
    .prepare("SELECT current_target FROM redirects WHERE slug = ? AND tenant_id = ?")
    .get(slug, tenantId) as { current_target: string } | undefined;
  return row?.current_target ?? null;
}

export function upsertRedirect(
  db: Db,
  actor: Actor,
  input: { slug: string; target: string }
): RedirectRow {
  if (!input.slug || !input.target) {
    throw new Error("slug and target are required");
  }
  const existing = db
    .prepare("SELECT * FROM redirects WHERE slug = ?")
    .get(input.slug) as RedirectRow | undefined;
  if (existing && existing.tenant_id !== actor.tenantId) {
    throw notFound(`redirect '${input.slug}' not found`);
  }
  db.prepare(
    `INSERT INTO redirects (slug, tenant_id, current_target, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       current_target = excluded.current_target,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).run(input.slug, actor.tenantId, input.target, actor.id, nowIso());
  emit(db, {
    type: "redirect.updated",
    actorId: actor.id,
    entityType: "redirect",
    entityId: input.slug,
    payload: { target: input.target },
  });
  return db
    .prepare("SELECT * FROM redirects WHERE slug = ?")
    .get(input.slug) as unknown as RedirectRow;
}

/**
 * Deterministic classification of one plan item.
 *
 * INV-02: an incorrect value physically in ink always requires physical
 * intervention — a corrected redirect can never close an ink mismatch.
 * A redirect-managed placement closes at zero spend once the live
 * destination matches the approved target.
 */
export function classify(
  db: Db,
  actor: Actor,
  placement: PlacementRow,
  observed: RevisionRow | null,
  target: RevisionRow
): Decision {
  if (!observed) {
    return { state: "UNKNOWN", reason: "installed version unknown; field verification required" };
  }
  if (observed.id === target.id) {
    return { state: "VERIFIED", reason: "installed revision matches target" };
  }

  const inkFields = JSON.parse(placement.ink_fields ?? "[]") as string[];
  const obsBody = JSON.parse(observed.body) as Record<string, unknown>;
  const tgtBody = JSON.parse(target.body) as Record<string, unknown>;
  const inkDiffs = inkFields.filter(
    (f) => canonicalize(obsBody[f]) !== canonicalize(tgtBody[f])
  );
  if (inkDiffs.length > 0) {
    return {
      state: "REPRINT",
      reason: `printed ink fields differ: ${inkDiffs.join(", ")} — physical intervention required`,
    };
  }

  const redirectDiffers =
    (observed.redirect_target ?? null) !== (target.redirect_target ?? null);
  if (redirectDiffers && placement.managed_redirect === 1 && placement.redirect_slug) {
    const live = liveRedirectTarget(db, actor.tenantId, placement.redirect_slug);
    if (live !== null && live === target.redirect_target) {
      return { state: "VERIFIED", reason: "managed destination already resolves to approved target" };
    }
    return {
      state: "REDIRECT_CHECK",
      reason: "managed redirect is stale; operator correction then fresh scan required",
    };
  }
  if (redirectDiffers) {
    return {
      state: "REPRINT",
      reason: "revision stale and redirect is not operator-managed; physical intervention required",
    };
  }
  return { state: "VERIFIED", reason: "no effective difference from target revision" };
}

function applyDecision(
  db: Db,
  actor: Actor,
  item: PlanItemRow,
  decision: Decision,
  evidence?: Record<string, unknown>
): PlanItemRow {
  db.prepare(
    `UPDATE plan_items
       SET state = ?, reason = ?, decided_by = ?, decided_at = ?, evidence = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    decision.state,
    decision.reason,
    actor.id,
    nowIso(),
    evidence ? JSON.stringify(evidence) : null,
    nowIso(),
    item.id
  );
  emit(db, {
    type: `plan.${decision.state.toLowerCase()}`,
    campaignId: item.campaign_id,
    actorId: actor.id,
    entityType: "plan_item",
    entityId: item.id,
    payload: { placementId: item.placement_id, reason: decision.reason, evidence },
  });
  return db
    .prepare("SELECT * FROM plan_items WHERE id = ?")
    .get(item.id) as unknown as PlanItemRow;
}

function loadItem(db: Db, campaignId: string, item: PlanItemRow) {
  const placement = getPlacement(db, campaignId, item.placement_id);
  const target = getRevision(db, campaignId, item.target_revision_id);
  const observed = placement.observed_revision_id
    ? getRevision(db, campaignId, placement.observed_revision_id)
    : null;
  return { placement, target, observed };
}

/**
 * Evaluate every open plan item in the campaign against the current target
 * revision. VERIFIED and EXCEPTION items are terminal and not reclassified.
 */
export function evaluateCampaign(
  db: Db,
  actor: Actor,
  campaignId: string
): { planItemId: string; placementId: string; siteCode: string; state: string; reason: string }[] {
  getCampaign(db, actor, campaignId);
  const items = db
    .prepare(
      `SELECT pi.*, p.site_code FROM plan_items pi
         JOIN placements p ON p.id = pi.placement_id
        WHERE pi.campaign_id = ? AND pi.state NOT IN ('VERIFIED','EXCEPTION')
        ORDER BY p.site_code`
    )
    .all(campaignId) as unknown as (PlanItemRow & { site_code: string })[];

  const results = [];
  for (const item of items) {
    const { placement, target, observed } = loadItem(db, campaignId, item);
    const decision = classify(db, actor, placement, observed, target);
    const updated = applyDecision(db, actor, item, decision);
    results.push({
      planItemId: item.id,
      placementId: item.placement_id,
      siteCode: item.site_code,
      state: updated.state,
      reason: updated.reason,
    });
  }
  return results;
}

/**
 * Record a fresh field scan of a managed destination. Closes the item only
 * when the scan agrees with the operator-confirmed registry AND matches the
 * approved target — at zero spend. Scan/registry disagreement requires a
 * second check and keeps the item open.
 */
export function recordScan(
  db: Db,
  actor: Actor,
  campaignId: string,
  planItemId: string,
  input: { resolvedTarget: string }
): PlanItemRow {
  getCampaign(db, actor, campaignId);
  const item = db
    .prepare("SELECT * FROM plan_items WHERE id = ? AND campaign_id = ?")
    .get(planItemId, campaignId) as PlanItemRow | undefined;
  if (!item) throw notFound(`plan item '${planItemId}' not found`);
  if (item.state === "VERIFIED" || item.state === "EXCEPTION") {
    throw conflict(`plan item already ${item.state.toLowerCase()}`);
  }

  const { placement, target } = loadItem(db, campaignId, item);
  if (placement.managed_redirect !== 1 || !placement.redirect_slug) {
    throw conflict("placement has no managed redirect to scan");
  }
  const live = liveRedirectTarget(db, actor.tenantId, placement.redirect_slug);
  const evidence = {
    type: "redirect-scan",
    resolvedTarget: input.resolvedTarget,
    registryTarget: live,
    approvedTarget: target.redirect_target,
    scannedAt: nowIso(),
  };

  if (input.resolvedTarget !== live) {
    applyDecision(db, actor, item, {
      state: "REDIRECT_CHECK",
      reason: "scan disagrees with operator registry; second check required",
    }, evidence);
    throw conflict(
      "scan disagrees with operator registry; second check required"
    );
  }
  if (input.resolvedTarget === target.redirect_target) {
    return applyDecision(db, actor, item, {
      state: "VERIFIED",
      reason: "fresh scan confirms managed destination matches approved target (zero spend)",
    }, evidence);
  }
  return applyDecision(db, actor, item, {
    state: "REDIRECT_CHECK",
    reason: "destination still does not match approved target",
  }, evidence);
}
