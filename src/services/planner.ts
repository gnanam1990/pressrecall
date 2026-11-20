import type { Db } from "../db/connection.js";
import type { Actor } from "../http/auth.js";
import { badRequest, conflict, notFound } from "../domain/errors.js";
import { nowIso } from "../domain/ids.js";
import { canonicalize } from "../domain/canon.js";
import { emit } from "./events.js";
import type { Resolver } from "./fetcher.js";
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
  managed_url: string | null;
  updated_by: string;
  updated_at: string;
}

export interface Decision {
  state: string;
  reason: string;
}

/**
 * What the operator's deployed redirector actually serves. `attempted` false
 * means no live observation exists (no managed URL registered or fetch
 * failed) — a registry row alone is intended mapping, not observed service.
 */
export interface LiveObservation {
  attempted: boolean;
  location: string | null;
  registryTarget: string | null;
  managedUrl: string | null;
  httpStatus?: number;
  error?: string;
}

export function getRedirect(db: Db, tenantId: string, slug: string): RedirectRow | undefined {
  return db
    .prepare("SELECT * FROM redirects WHERE slug = ? AND tenant_id = ?")
    .get(slug, tenantId) as RedirectRow | undefined;
}

export function upsertRedirect(
  db: Db,
  actor: Actor,
  input: { slug: string; target: string; managedUrl?: string }
): RedirectRow {
  if (!input.slug || !input.target) {
    throw badRequest("slug and target are required");
  }
  const existing = db
    .prepare("SELECT * FROM redirects WHERE slug = ?")
    .get(input.slug) as RedirectRow | undefined;
  if (existing && existing.tenant_id !== actor.tenantId) {
    throw notFound(`redirect '${input.slug}' not found`);
  }
  db.prepare(
    `INSERT INTO redirects (slug, tenant_id, current_target, managed_url, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       current_target = excluded.current_target,
       managed_url = COALESCE(excluded.managed_url, redirects.managed_url),
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).run(
    input.slug,
    actor.tenantId,
    input.target,
    input.managedUrl ?? null,
    actor.id,
    nowIso()
  );
  emit(db, {
    type: "redirect.updated",
    actorId: actor.id,
    entityType: "redirect",
    entityId: input.slug,
    payload: { target: input.target, managedUrl: input.managedUrl },
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
 * A redirect-managed placement can only close on an observed resolution of
 * its deployed managed URL matching the approved target (FR-04); the
 * registry entry alone is intent, not proof.
 */
export function classify(
  placement: PlacementRow,
  observed: RevisionRow | null,
  target: RevisionRow,
  live?: LiveObservation
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
    if (live?.attempted && live.location === target.redirect_target) {
      return { state: "VERIFIED", reason: "deployed managed URL observed resolving to approved target" };
    }
    return {
      state: "REDIRECT_CHECK",
      reason: "managed redirect stale or unverified; operator correction then observed scan required",
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

/** Fetch the deployed redirect's actual Location under the scoped policy. */
async function observeLive(
  db: Db,
  tenantId: string,
  slug: string,
  resolve: Resolver
): Promise<LiveObservation> {
  const reg = getRedirect(db, tenantId, slug);
  const base: LiveObservation = {
    attempted: false,
    location: null,
    registryTarget: reg?.current_target ?? null,
    managedUrl: reg?.managed_url ?? null,
  };
  if (!reg?.managed_url) return base;
  try {
    const r = await resolve(reg.managed_url);
    return {
      ...base,
      attempted: true,
      location: r.location,
      httpStatus: r.status,
    };
  } catch (err) {
    return { ...base, attempted: true, error: String((err as Error).message) };
  }
}

/**
 * Evaluate every open plan item in the campaign against the current target
 * revision, performing live resolution where a managed redirect applies.
 * VERIFIED and EXCEPTION items are terminal and not reclassified.
 */
export async function evaluateCampaign(
  db: Db,
  actor: Actor,
  campaignId: string,
  resolve: Resolver
): Promise<{ planItemId: string; placementId: string; siteCode: string; state: string; reason: string }[]> {
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
    let live: LiveObservation | undefined;
    if (placement.managed_redirect === 1 && placement.redirect_slug) {
      live = await observeLive(db, actor.tenantId, placement.redirect_slug, resolve);
    }
    const decision = classify(placement, observed, target, live);
    const updated = applyDecision(db, actor, item, decision, live?.attempted ? { live } : undefined);
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
 * Record a scan of a managed destination.
 *
 * Default (server-verified): the server fetches the placement's deployed
 * managed URL under the scoped site policy and records the observed Location.
 * VERIFIED only when that observed resolution equals the approved target.
 *
 * Manual (`manualLocation`): retains an explicit UNVERIFIED observation —
 * a field report of what the scan showed. It records evidence but can never
 * close the item.
 */
export async function recordScan(
  db: Db,
  actor: Actor,
  campaignId: string,
  planItemId: string,
  input: { manualLocation?: string; note?: string },
  resolve: Resolver
): Promise<PlanItemRow> {
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

  // Explicit manual observation: recorded, never sufficient to verify.
  if (input.manualLocation !== undefined) {
    const live = await observeLive(db, actor.tenantId, placement.redirect_slug, resolve);
    return applyDecision(db, actor, item, {
      state: item.state === "OBSERVED" ? "REDIRECT_CHECK" : item.state,
      reason:
        "manual scan recorded (UNVERIFIED); server-observed resolution required to close",
    }, {
      type: "manual-scan",
      method: "manual",
      reportedLocation: input.manualLocation,
      note: input.note ?? null,
      verified: false,
      observedBy: actor.id,
      serverObservation: live,
      scannedAt: nowIso(),
    });
  }

  const live = await observeLive(db, actor.tenantId, placement.redirect_slug, resolve);
  const evidence = {
    type: "redirect-scan",
    method: "http",
    ...live,
    approvedTarget: target.redirect_target,
    scannedAt: nowIso(),
  };

  if (!live.attempted || live.error) {
    return applyDecision(db, actor, item, {
      state: "REDIRECT_CHECK",
      reason: live.managedUrl
        ? `live resolution failed (${live.error ?? "no response"}); retry or record a manual scan`
        : "no managed URL registered for this placement's redirect",
    }, evidence);
  }
  if (live.location === target.redirect_target) {
    return applyDecision(db, actor, item, {
      state: "VERIFIED",
      reason: "deployed managed URL observed resolving to approved target (zero spend)",
    }, evidence);
  }
  return applyDecision(db, actor, item, {
    state: "REDIRECT_CHECK",
    reason: `deployed managed URL resolves to '${live.location ?? "(no location)"}', not the approved target`,
  }, evidence);
}
