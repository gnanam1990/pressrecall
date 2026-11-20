import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Db } from "../db/connection.js";
import type { Actor } from "../http/auth.js";
import { badRequest, conflict, notFound } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import { sha256hex, digestOf } from "../domain/canon.js";
import { emit } from "./events.js";

export interface CampaignRow {
  id: string;
  tenant_id: string;
  name: string;
  budget_cap_atoms: number;
  budget_token: string;
  status: string;
  exception_note: string | null;
  created_at: string;
}

export interface RevisionRow {
  id: string;
  campaign_id: string;
  parent_id: string | null;
  seq: number;
  asset_digest: string;
  asset_path: string;
  change_class: string;
  body: string;
  redirect_target: string | null;
  rights_note: string;
  published_by: string;
  created_at: string;
}

export interface PlacementRow {
  id: string;
  campaign_id: string;
  site_code: string;
  site_label: string;
  format: string;
  managed_redirect: number;
  redirect_slug: string | null;
  observed_revision_id: string | null;
  observed_revision_digest: string | null;
  observed_at: string | null;
  deadline: string | null;
  created_at: string;
}

export interface PlanItemRow {
  id: string;
  campaign_id: string;
  placement_id: string;
  target_revision_id: string;
  reason: string;
  state: string;
  decided_by: string | null;
  decided_at: string | null;
  evidence: string | null;
  created_at: string;
  updated_at: string;
}

export function getCampaign(db: Db, actor: Actor, id: string): CampaignRow {
  const row = db
    .prepare("SELECT * FROM campaigns WHERE id = ?")
    .get(id) as CampaignRow | undefined;
  // Cross-tenant isolation: a campaign outside the actor's scope is invisible.
  if (!row || row.tenant_id !== actor.tenantId) {
    throw notFound(`campaign '${id}' not found`);
  }
  return row;
}

export function getRevision(
  db: Db,
  campaignId: string,
  id: string
): RevisionRow {
  const row = db
    .prepare("SELECT * FROM revisions WHERE id = ? AND campaign_id = ?")
    .get(id, campaignId) as RevisionRow | undefined;
  if (!row) throw notFound(`revision '${id}' not found in campaign`);
  return row;
}

export function getPlacement(
  db: Db,
  campaignId: string,
  id: string
): PlacementRow {
  const row = db
    .prepare("SELECT * FROM placements WHERE id = ? AND campaign_id = ?")
    .get(id, campaignId) as PlacementRow | undefined;
  if (!row) throw notFound(`placement '${id}' not found in campaign`);
  return row;
}

export function latestRevision(db: Db, campaignId: string): RevisionRow | undefined {
  return db
    .prepare(
      "SELECT * FROM revisions WHERE campaign_id = ? ORDER BY seq DESC LIMIT 1"
    )
    .get(campaignId) as RevisionRow | undefined;
}

export function createCampaign(
  db: Db,
  actor: Actor,
  input: { name: string; budgetCapAtoms?: number; budgetToken?: string }
): CampaignRow {
  if (!input.name) throw badRequest("name is required");
  const id = newId("cmp");
  db.prepare(
    `INSERT INTO campaigns (id, tenant_id, name, budget_cap_atoms, budget_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    actor.tenantId,
    input.name,
    input.budgetCapAtoms ?? 0,
    input.budgetToken ?? "USD",
    nowIso()
  );
  emit(db, {
    type: "campaign.created",
    campaignId: id,
    actorId: actor.id,
    entityType: "campaign",
    entityId: id,
    payload: { name: input.name },
  });
  return db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as unknown as CampaignRow;
}

type ChangeClass = "initial" | "body" | "redirect" | "both" | "none";

function computeChangeClass(
  parent: RevisionRow | undefined,
  body: Record<string, unknown>,
  redirectTarget: string | null
): ChangeClass {
  if (!parent) return "initial";
  const parentBody = JSON.parse(parent.body) as Record<string, unknown>;
  const bodyChanged = digestOf(parentBody) !== digestOf(body);
  const redirectChanged = (parent.redirect_target ?? null) !== redirectTarget;
  if (bodyChanged && redirectChanged) return "both";
  if (bodyChanged) return "body";
  if (redirectChanged) return "redirect";
  return "none";
}

export interface RevisionInput {
  assetText?: string;
  assetBase64?: string;
  changeClass?: string;
  body?: Record<string, unknown>;
  redirectTarget?: string | null;
  parentId?: string;
  rightsNote?: string;
}

/**
 * Publish an immutable artwork revision. The caller declares a change class;
 * the server deterministically recomputes it from the parent diff and rejects
 * a mismatch (409). After publish, all plan items in the campaign retarget to
 * the new revision and previously-decided items are marked stale (OBSERVED).
 */
export function publishRevision(
  db: Db,
  actor: Actor,
  objectDir: string,
  campaignId: string,
  input: RevisionInput
): RevisionRow {
  const campaign = getCampaign(db, actor, campaignId);
  if (input.assetText === undefined && input.assetBase64 === undefined) {
    throw badRequest("assetText or assetBase64 is required");
  }
  const assetBytes =
    input.assetBase64 !== undefined
      ? Buffer.from(input.assetBase64, "base64")
      : Buffer.from(input.assetText ?? "", "utf8");
  if (assetBytes.length === 0) throw badRequest("asset must not be empty");
  const assetDigest = sha256hex(assetBytes);

  const parent = input.parentId
    ? getRevision(db, campaignId, input.parentId)
    : latestRevision(db, campaignId);
  const seq = parent ? parent.seq + 1 : 1;
  const body = input.body ?? {};
  const redirectTarget = input.redirectTarget ?? null;

  const computed = computeChangeClass(parent, body, redirectTarget);
  if (input.changeClass !== undefined && input.changeClass !== computed) {
    throw conflict(
      `declared changeClass '${input.changeClass}' does not match computed '${computed}'`
    );
  }

  const id = newId("rev");
  const relPath = join(campaignId, `${assetDigest}.bin`);
  const absPath = join(objectDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, assetBytes);

  const insert = db.prepare(
    `INSERT INTO revisions
       (id, campaign_id, parent_id, seq, asset_digest, asset_path, change_class,
        body, redirect_target, rights_note, published_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    insert.run(
      id,
      campaignId,
      parent?.id ?? null,
      seq,
      assetDigest,
      relPath,
      computed,
      JSON.stringify(body),
      redirectTarget,
      input.rightsNote ?? "",
      actor.id,
      nowIso()
    );
  } catch (err) {
    if (String(err).includes("UNIQUE") && String(err).includes("asset_digest")) {
      throw conflict("identical asset already published in this campaign");
    }
    throw err;
  }

  emit(db, {
    type: "revision.published",
    campaignId,
    actorId: actor.id,
    entityType: "revision",
    entityId: id,
    payload: {
      seq,
      assetDigest,
      changeClass: computed,
      parentId: parent?.id ?? null,
      rightsNote: input.rightsNote ?? "",
    },
  });

  // New revision marks existing decided site records stale; they retarget to it.
  const stale = db
    .prepare(
      `UPDATE plan_items
         SET target_revision_id = ?, state = 'OBSERVED',
             reason = 'superseded by revision seq ' || ?,
             decided_by = NULL, decided_at = NULL, updated_at = ?
       WHERE campaign_id = ? AND state IN ('VERIFIED','EXCEPTION','REDIRECT_CHECK','REPRINT','OBSERVED')`
    )
    .run(id, seq, nowIso(), campaignId);
  if (stale.changes > 0) {
    emit(db, {
      type: "plan.retargeted",
      campaignId,
      actorId: actor.id,
      entityType: "campaign",
      entityId: campaignId,
      payload: { targetRevisionId: id, markedStale: stale.changes },
    });
  }

  void campaign;
  return getRevision(db, campaignId, id);
}

export interface PlacementInput {
  siteCode: string;
  siteLabel: string;
  format: string;
  managedRedirect?: boolean;
  redirectSlug?: string;
  observedRevisionId?: string;
  observedDigest?: string;
  observedAt?: string;
  deadline?: string;
}

/**
 * Register an installed placement and its observed version. An unknown
 * installed version creates a plan item in state UNKNOWN — the field
 * verification queue (FR-02). A known observed revision yields OBSERVED.
 */
export function createPlacement(
  db: Db,
  actor: Actor,
  campaignId: string,
  input: PlacementInput
): { placement: PlacementRow; planItem: PlanItemRow } {
  getCampaign(db, actor, campaignId);
  if (!input.siteCode || !input.siteLabel || !input.format) {
    throw badRequest("siteCode, siteLabel and format are required");
  }
  const target = latestRevision(db, campaignId);
  if (!target) {
    throw conflict("campaign has no published revision to target");
  }

  const placementId = newId("plc");
  const observed = resolveObservation(db, campaignId, input);

  db.prepare(
    `INSERT INTO placements
       (id, campaign_id, site_code, site_label, format, managed_redirect,
        redirect_slug, observed_revision_id, observed_revision_digest,
        observed_at, deadline, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    placementId,
    campaignId,
    input.siteCode,
    input.siteLabel,
    input.format,
    input.managedRedirect ? 1 : 0,
    input.redirectSlug ?? null,
    observed.revisionId,
    observed.digest,
    input.observedAt ?? nowIso(),
    input.deadline ?? null,
    nowIso()
  );

  const planItem = createPlanItem(
    db,
    actor,
    campaignId,
    placementId,
    target.id,
    observed
  );
  return {
    placement: getPlacement(db, campaignId, placementId),
    planItem,
  };
}

interface Observation {
  revisionId: string | null;
  digest: string | null;
  known: boolean;
}

function resolveObservation(
  db: Db,
  campaignId: string,
  input: { observedRevisionId?: string; observedDigest?: string }
): Observation {
  if (input.observedRevisionId) {
    // Cross-campaign / foreign revision reference is rejected outright.
    const rev = db
      .prepare("SELECT id, campaign_id FROM revisions WHERE id = ?")
      .get(input.observedRevisionId) as
      | { id: string; campaign_id: string }
      | undefined;
    if (!rev || rev.campaign_id !== campaignId) {
      throw conflict(
        `observed revision '${input.observedRevisionId}' is not part of this campaign`
      );
    }
    return { revisionId: rev.id, digest: null, known: true };
  }
  if (input.observedDigest) {
    const rev = db
      .prepare(
        "SELECT id FROM revisions WHERE campaign_id = ? AND asset_digest = ?"
      )
      .get(campaignId, input.observedDigest) as { id: string } | undefined;
    if (rev) return { revisionId: rev.id, digest: null, known: true };
    return { revisionId: null, digest: input.observedDigest, known: false };
  }
  return { revisionId: null, digest: null, known: false };
}

function createPlanItem(
  db: Db,
  actor: Actor,
  campaignId: string,
  placementId: string,
  targetRevisionId: string,
  observed: Observation
): PlanItemRow {
  const id = newId("pln");
  const state = observed.known ? "OBSERVED" : "UNKNOWN";
  const reason = observed.known
    ? "observed installed revision on import"
    : "installed version unknown; field verification required";
  db.prepare(
    `INSERT INTO plan_items
       (id, campaign_id, placement_id, target_revision_id, reason, state,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, campaignId, placementId, targetRevisionId, reason, state, nowIso(), nowIso());
  emit(db, {
    type: "plan_item.created",
    campaignId,
    actorId: actor.id,
    entityType: "plan_item",
    entityId: id,
    payload: { placementId, state, targetRevisionId },
  });
  return db
    .prepare("SELECT * FROM plan_items WHERE id = ?")
    .get(id) as unknown as PlanItemRow;
}

/**
 * Record a fresh observation for an existing placement (staff scan or photo
 * review). Unknown digests keep the item in the verification queue.
 */
export function recordObservation(
  db: Db,
  actor: Actor,
  campaignId: string,
  placementId: string,
  input: { observedRevisionId?: string; observedDigest?: string; observedAt?: string }
): { placement: PlacementRow; planItem: PlanItemRow } {
  getCampaign(db, actor, campaignId);
  const placement = getPlacement(db, campaignId, placementId);
  const observed = resolveObservation(db, campaignId, input);

  db.prepare(
    `UPDATE placements
       SET observed_revision_id = ?, observed_revision_digest = ?, observed_at = ?
     WHERE id = ?`
  ).run(
    observed.revisionId,
    observed.digest,
    input.observedAt ?? nowIso(),
    placement.id
  );

  const state = observed.known ? "OBSERVED" : "UNKNOWN";
  const reason = observed.known
    ? "fresh observation recorded"
    : "installed version unknown; field verification required";
  db.prepare(
    `UPDATE plan_items
       SET state = ?, reason = ?, decided_by = NULL, decided_at = NULL, updated_at = ?
     WHERE placement_id = ?`
  ).run(state, reason, nowIso(), placement.id);

  const planItem = db
    .prepare("SELECT * FROM plan_items WHERE placement_id = ?")
    .get(placement.id) as unknown as PlanItemRow;

  emit(db, {
    type: "placement.observed",
    campaignId,
    actorId: actor.id,
    entityType: "placement",
    entityId: placement.id,
    payload: {
      observedRevisionId: observed.revisionId,
      observedDigest: observed.digest,
      known: observed.known,
      planState: state,
    },
  });

  return {
    placement: getPlacement(db, campaignId, placement.id),
    planItem,
  };
}

export function placementView(
  db: Db,
  placement: PlacementRow
): Record<string, unknown> {
  const item = db
    .prepare("SELECT * FROM plan_items WHERE placement_id = ?")
    .get(placement.id) as PlanItemRow | undefined;
  return {
    id: placement.id,
    siteCode: placement.site_code,
    siteLabel: placement.site_label,
    format: placement.format,
    managedRedirect: !!placement.managed_redirect,
    redirectSlug: placement.redirect_slug,
    observedRevisionId: placement.observed_revision_id,
    observedRevisionDigest: placement.observed_revision_digest,
    observedAt: placement.observed_at,
    deadline: placement.deadline,
    planItem: item
      ? {
          id: item.id,
          targetRevisionId: item.target_revision_id,
          state: item.state,
          reason: item.reason,
          decidedBy: item.decided_by,
          decidedAt: item.decided_at,
        }
      : null,
  };
}

export function revisionView(rev: RevisionRow): Record<string, unknown> {
  return {
    id: rev.id,
    campaignId: rev.campaign_id,
    parentId: rev.parent_id,
    seq: rev.seq,
    assetDigest: rev.asset_digest,
    changeClass: rev.change_class,
    body: JSON.parse(rev.body),
    redirectTarget: rev.redirect_target,
    rightsNote: rev.rights_note,
    publishedBy: rev.published_by,
    createdAt: rev.created_at,
  };
}
