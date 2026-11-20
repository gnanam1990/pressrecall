import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/connection.js";
import type { Actor } from "../http/auth.js";
import { badRequest, conflict, notFound, policyDenied } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import { sha256hex } from "../domain/canon.js";
import { emit } from "./events.js";
import { getCampaign, getPlacement } from "./campaigns.js";
import { getApproval, getQuote } from "./quotes.js";
import type { IntentRow } from "./settlement.js";

export interface DeliveryRow {
  id: string;
  intent_id: string;
  campaign_id: string;
  placement_id: string;
  qty: number;
  revision_id: string;
  revision_digest: string | null;
  shipment_ref: string | null;
  client_key: string;
  created_by: string;
  created_at: string;
}

export interface EvidenceRow {
  id: string;
  campaign_id: string;
  placement_id: string;
  client_key: string;
  payload_digest: string;
  payload_path: string;
  revision_digest_seen: string | null;
  captured_at: string | null;
  note: string | null;
  uploader_id: string;
  created_at: string;
}

interface PlanItemRow {
  id: string;
  campaign_id: string;
  placement_id: string;
  target_revision_id: string;
  state: string;
  reason: string;
}

function planItemOf(db: Db, placementId: string): PlanItemRow {
  const item = db
    .prepare("SELECT * FROM plan_items WHERE placement_id = ?")
    .get(placementId) as PlanItemRow | undefined;
  if (!item) throw notFound("plan item not found for placement");
  return item;
}

function intentOf(db: Db, intentId: string): IntentRow {
  const i = db
    .prepare("SELECT * FROM order_intents WHERE id = ?")
    .get(intentId) as IntentRow | undefined;
  if (!i) throw notFound(`order intent '${intentId}' not found`);
  return i;
}

/** The shop that owns the bound quote — and only that shop — acts on the job. */
function requireOwnerShop(db: Db, actor: Actor, intent: IntentRow): void {
  const approval = getApproval(db, intent.approval_id);
  const quote = getQuote(db, intent.campaign_id, approval.quote_id);
  if (actor.printerId !== quote.printer_id) {
    throw policyDenied("only the shop that owns this job may act on it");
  }
}

function setPlanState(
  db: Db,
  actor: Actor,
  item: PlanItemRow,
  state: string,
  reason: string,
  evidence?: Record<string, unknown>
): void {
  db.prepare(
    "UPDATE plan_items SET state = ?, reason = ?, decided_by = ?, decided_at = ?, evidence = ?, updated_at = ? WHERE id = ?"
  ).run(
    state,
    reason,
    actor.id,
    nowIso(),
    evidence ? JSON.stringify(evidence) : null,
    nowIso(),
    item.id
  );
}

/**
 * Shop formally accepts the confirmed job. Payment confirmation and shop
 * acceptance stay distinct recorded steps.
 */
export function acceptJob(db: Db, actor: Actor, intentId: string): IntentRow {
  const intent = intentOf(db, intentId);
  requireOwnerShop(db, actor, intent);
  if (intent.state !== "CONFIRMED") {
    throw conflict(`intent is '${intent.state}'; job acceptance requires a confirmed settlement`);
  }
  emit(db, {
    type: "job.accepted",
    campaignId: intent.campaign_id,
    actorId: actor.id,
    entityType: "order_intent",
    entityId: intentId,
    payload: { shopRef: intent.shop_ref },
  });
  return intent;
}

/**
 * Record a (possibly partial) delivery of a revision to a placement.
 * Idempotent on (campaign, clientKey): identical payload replays return the
 * original row, a changed payload conflicts. A delivery of a revision other
 * than the placement's target keeps the site open — an invoice being paid
 * never marks installation complete.
 */
export function recordDelivery(
  db: Db,
  actor: Actor,
  intentId: string,
  input: {
    placementId: string;
    qty: number;
    revisionId: string;
    shipmentRef?: string;
    clientKey: string;
  }
): { delivery: DeliveryRow; created: boolean } {
  const intent = intentOf(db, intentId);
  requireOwnerShop(db, actor, intent);
  if (intent.state !== "CONFIRMED" && intent.state !== "DELIVERED") {
    throw conflict(`intent is '${intent.state}'; deliveries require an accepted job`);
  }
  if (!input.clientKey) throw badRequest("clientKey is required");
  if (!input.qty || input.qty <= 0) throw badRequest("qty must be > 0");
  const placement = getPlacement(db, intent.campaign_id, input.placementId);
  const revision = db
    .prepare("SELECT * FROM revisions WHERE id = ? AND campaign_id = ?")
    .get(input.revisionId, intent.campaign_id) as
    | { id: string; asset_digest: string }
    | undefined;
  if (!revision) throw badRequest("delivered revision is not part of this campaign");

  const existing = db
    .prepare(
      "SELECT * FROM deliveries WHERE campaign_id = ? AND client_key = ?"
    )
    .get(intent.campaign_id, input.clientKey) as DeliveryRow | undefined;
  if (existing) {
    const same =
      existing.intent_id === intentId &&
      existing.placement_id === input.placementId &&
      existing.qty === input.qty &&
      existing.revision_id === input.revisionId;
    if (same) return { delivery: existing, created: false };
    throw conflict("clientKey already used with a different delivery payload");
  }

  const id = newId("dly");
  db.prepare(
    `INSERT INTO deliveries
       (id, intent_id, campaign_id, placement_id, qty, revision_id,
        revision_digest, shipment_ref, client_key, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    intentId,
    intent.campaign_id,
    placement.id,
    input.qty,
    revision.id,
    revision.asset_digest,
    input.shipmentRef ?? null,
    input.clientKey,
    actor.id,
    nowIso()
  );

  const item = planItemOf(db, placement.id);
  const onTarget = revision.id === item.target_revision_id;
  emit(db, {
    type: onTarget ? "delivery.recorded" : "delivery.mismatch",
    campaignId: intent.campaign_id,
    actorId: actor.id,
    entityType: "delivery",
    entityId: id,
    payload: {
      placementId: placement.id,
      intentId,
      revisionId: revision.id,
      targetRevisionId: item.target_revision_id,
      qty: input.qty,
      note: onTarget
        ? "delivered revision matches target — installation still requires field evidence"
        : "delivered revision does not match target — site remains open",
    },
  });
  if (!onTarget && item.state === "VERIFIED") {
    setPlanState(
      db,
      actor,
      item,
      "REPRINT",
      `delivered revision ${revision.id} does not match target ${item.target_revision_id} — reopened`,
      { deliveryId: id }
    );
  }

  // Intent moves to DELIVERED when delivered quantity covers the approved
  // quantity — fulfillment state, independent of site verification.
  const approval = getApproval(db, intent.approval_id);
  const quote = getQuote(db, intent.campaign_id, approval.quote_id);
  const delivered = db
    .prepare(
      "SELECT COALESCE(SUM(qty),0) AS total FROM deliveries WHERE intent_id = ?"
    )
    .get(intentId) as { total: number };
  if (intent.state === "CONFIRMED" && delivered.total >= quote.qty) {
    db.prepare(
      "UPDATE order_intents SET state = 'DELIVERED' WHERE id = ?"
    ).run(intentId);
  }
  return {
    delivery: db
      .prepare("SELECT * FROM deliveries WHERE id = ?")
      .get(id) as unknown as DeliveryRow,
    created: true,
  };
}

/** Buyer flags a fulfillment problem — the job (and its evidence) freezes. */
export function disputeIntent(db: Db, actor: Actor, intentId: string): IntentRow {
  const intent = intentOf(db, intentId);
  getCampaign(db, actor, intent.campaign_id);
  if (intent.state === "DISPUTED") return intent;
  db.prepare(
    "UPDATE order_intents SET state = 'DISPUTED' WHERE id = ?"
  ).run(intentId);
  emit(db, {
    type: "order_intent.disputed",
    campaignId: intent.campaign_id,
    actorId: actor.id,
    entityType: "order_intent",
    entityId: intentId,
    payload: { previousState: intent.state },
  });
  return intentOf(db, intentId);
}

/**
 * Idempotent field evidence upload. Offline clients retry with the same
 * clientKey — an identical payload replays onto the original attachment
 * (one row, one current installation); a changed payload under the same key
 * conflicts. A digest matching the target revision verifies installation;
 * a stale/mismatched digest reopens the site.
 */
export function uploadEvidence(
  db: Db,
  actor: Actor,
  campaignId: string,
  placementId: string,
  objectDir: string,
  input: {
    clientKey: string;
    assetText?: string;
    assetBase64?: string;
    revisionDigestSeen?: string;
    capturedAt?: string;
    note?: string;
  }
): { evidence: EvidenceRow; created: boolean; installation: InstallationStatus } {
  getCampaign(db, actor, campaignId);
  const placement = getPlacement(db, campaignId, placementId);
  if (!input.clientKey) throw badRequest("clientKey is required");
  const bytes =
    input.assetBase64 !== undefined
      ? Buffer.from(input.assetBase64, "base64")
      : Buffer.from(input.assetText ?? "", "utf8");
  if (bytes.length === 0) throw badRequest("evidence payload is required");
  const digest = sha256hex(bytes);

  const existing = db
    .prepare(
      "SELECT * FROM evidence WHERE campaign_id = ? AND client_key = ?"
    )
    .get(campaignId, input.clientKey) as EvidenceRow | undefined;
  if (existing) {
    if (
      existing.payload_digest === digest &&
      existing.placement_id === placementId
    ) {
      return {
        evidence: existing,
        created: false,
        installation: installationStatus(db, placementId),
      };
    }
    throw conflict("clientKey already used with a different evidence payload");
  }

  const id = newId("evd");
  const path = `evidence-${id}.bin`;
  writeFileSync(join(objectDir, path), bytes);
  db.prepare(
    `INSERT INTO evidence
       (id, campaign_id, placement_id, client_key, payload_digest,
        payload_path, revision_digest_seen, captured_at, note, uploader_id,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    campaignId,
    placementId,
    input.clientKey,
    digest,
    path,
    input.revisionDigestSeen ?? null,
    input.capturedAt ?? null,
    input.note ?? null,
    actor.id,
    nowIso()
  );

  const item = planItemOf(db, placementId);
  const target = db
    .prepare("SELECT asset_digest FROM revisions WHERE id = ?")
    .get(item.target_revision_id) as { asset_digest: string } | undefined;
  const seen = input.revisionDigestSeen ?? null;
  const matches = seen !== null && target !== undefined && seen === target.asset_digest;

  if (matches && item.state !== "VERIFIED") {
    setPlanState(db, actor, item, "VERIFIED",
      "field evidence matches target revision — corrected installation observed",
      { evidenceId: id, digest: seen });
    emit(db, {
      type: "evidence.matched",
      campaignId,
      actorId: actor.id,
      entityType: "plan_item",
      entityId: item.id,
      payload: { placementId, evidenceId: id, digest: seen },
    });
  } else if (matches && item.state === "VERIFIED") {
    emit(db, {
      type: "evidence.matched",
      campaignId,
      actorId: actor.id,
      entityType: "plan_item",
      entityId: item.id,
      payload: { placementId, evidenceId: id, digest: seen },
    });
  } else {
    emit(db, {
      type: "evidence.mismatch",
      campaignId,
      actorId: actor.id,
      entityType: "plan_item",
      entityId: item.id,
      payload: {
        placementId,
        evidenceId: id,
        digestSeen: seen,
        targetDigest: target?.asset_digest ?? null,
      },
    });
    if (item.state === "VERIFIED") {
      setPlanState(db, actor, item, "REPRINT",
        "field evidence no longer matches target revision — reopened",
        { evidenceId: id, digestSeen: seen });
      emit(db, {
        type: "placement.reopened",
        campaignId,
        actorId: actor.id,
        entityType: "plan_item",
        entityId: item.id,
        payload: { placementId, evidenceId: id },
      });
    }
  }

  return {
    evidence: db
      .prepare("SELECT * FROM evidence WHERE id = ?")
      .get(id) as unknown as EvidenceRow,
    created: true,
    installation: installationStatus(db, placementId),
  };
}

export interface InstallationStatus {
  status: "CURRENT" | "OPEN" | "MISMATCH";
  planItemState: string;
  matchedRevisionId: string | null;
  lastDeliveryRevisionId: string | null;
  lastEvidenceDigestSeen: string | null;
}

/** What is actually installed now, from the latest delivery + evidence. */
export function installationStatus(db: Db, placementId: string): InstallationStatus {
  const item = planItemOf(db, placementId);
  const lastDelivery = db
    .prepare(
      "SELECT revision_id FROM deliveries WHERE placement_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(placementId) as { revision_id: string } | undefined;
  const lastEvidence = db
    .prepare(
      "SELECT revision_digest_seen FROM evidence WHERE placement_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(placementId) as { revision_digest_seen: string | null } | undefined;
  const status =
    item.state === "VERIFIED"
      ? "CURRENT"
      : lastDelivery && lastDelivery.revision_id !== item.target_revision_id
        ? "MISMATCH"
        : "OPEN";
  return {
    status,
    planItemState: item.state,
    matchedRevisionId: status === "CURRENT" ? item.target_revision_id : null,
    lastDeliveryRevisionId: lastDelivery?.revision_id ?? null,
    lastEvidenceDigestSeen: lastEvidence?.revision_digest_seen ?? null,
  };
}

export function deliveryView(d: DeliveryRow): Record<string, unknown> {
  return {
    id: d.id,
    intentId: d.intent_id,
    placementId: d.placement_id,
    qty: d.qty,
    revisionId: d.revision_id,
    revisionDigest: d.revision_digest,
    shipmentRef: d.shipment_ref,
    clientKey: d.client_key,
    createdBy: d.created_by,
    createdAt: d.created_at,
  };
}

export function evidenceView(e: EvidenceRow): Record<string, unknown> {
  return {
    id: e.id,
    placementId: e.placement_id,
    clientKey: e.client_key,
    payloadDigest: e.payload_digest,
    revisionDigestSeen: e.revision_digest_seen,
    capturedAt: e.captured_at,
    note: e.note,
    uploaderId: e.uploader_id,
    createdAt: e.created_at,
  };
}
