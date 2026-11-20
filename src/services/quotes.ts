import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Db } from "../db/connection.js";
import type { Actor } from "../http/auth.js";
import { badRequest, conflict, notFound } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import { sha256hex, digestOf } from "../domain/canon.js";
import { emit } from "./events.js";
import { getCampaign, getRevision } from "./campaigns.js";

export interface QuoteRequestRow {
  id: string;
  campaign_id: string;
  plan_item_id: string;
  revision_id: string;
  dimensions: string;
  deadline: string | null;
  qty: number;
  status: string;
  created_by: string;
  created_at: string;
}

export interface QuoteRow {
  id: string;
  quote_request_id: string;
  campaign_id: string;
  printer_id: string;
  revision_id: string;
  revision_digest: string;
  recipient: string;
  qty: number;
  price_atoms: number;
  token: string;
  network: string;
  direction: string;
  dimensions: string;
  deadline: string | null;
  expires_at: string;
  quote_hash: string;
  created_at: string;
}

export interface ProofRow {
  id: string;
  quote_request_id: string;
  campaign_id: string;
  printer_id: string;
  revision_id: string;
  proof_digest: string;
  asset_path: string;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  campaign_id: string;
  quote_request_id: string;
  quote_id: string;
  quote_hash: string;
  proof_id: string;
  proof_hash: string;
  revision_id: string;
  budget_atoms: number;
  actor_id: string;
  superseded_by: string | null;
  created_at: string;
}

/**
 * Canonical quote hash — stable key order over UTF-8 fields: direction of
 * payment, network, token atom units, printer account, payee recipient,
 * expiry, revision digest, and order quantity.
 */
export function computeQuoteHash(q: {
  direction: string;
  network: string;
  token: string;
  priceAtoms: number;
  printerId: string;
  recipient: string;
  expiresAt: string;
  revisionDigest: string;
  qty: number;
}): string {
  return digestOf({
    direction: q.direction,
    network: q.network,
    token: q.token,
    priceAtoms: q.priceAtoms,
    printerAccount: q.printerId,
    recipient: q.recipient,
    expiresAt: q.expiresAt,
    revisionDigest: q.revisionDigest,
    orderQuantity: q.qty,
  });
}

export function createQuoteRequest(
  db: Db,
  actor: Actor,
  campaignId: string,
  input: {
    planItemId: string;
    revisionId: string;
    dimensions: string;
    deadline?: string;
    qty?: number;
  }
): QuoteRequestRow {
  getCampaign(db, actor, campaignId);
  const item = db
    .prepare("SELECT id FROM plan_items WHERE id = ? AND campaign_id = ?")
    .get(input.planItemId, campaignId) as { id: string } | undefined;
  if (!item) throw notFound(`plan item '${input.planItemId}' not found`);
  getRevision(db, campaignId, input.revisionId);
  if (!input.dimensions) throw badRequest("dimensions are required");

  const id = newId("qreq");
  db.prepare(
    `INSERT INTO quote_requests
       (id, campaign_id, plan_item_id, revision_id, dimensions, deadline, qty, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    campaignId,
    input.planItemId,
    input.revisionId,
    input.dimensions,
    input.deadline ?? null,
    input.qty ?? 1,
    actor.id,
    nowIso()
  );
  emit(db, {
    type: "quote_request.created",
    campaignId,
    actorId: actor.id,
    entityType: "quote_request",
    entityId: id,
    payload: { planItemId: input.planItemId, revisionId: input.revisionId },
  });
  return db
    .prepare("SELECT * FROM quote_requests WHERE id = ?")
    .get(id) as unknown as QuoteRequestRow;
}

export function getQuoteRequest(db: Db, id: string): QuoteRequestRow {
  const row = db
    .prepare("SELECT * FROM quote_requests WHERE id = ?")
    .get(id) as QuoteRequestRow | undefined;
  if (!row) throw notFound(`quote request '${id}' not found`);
  return row;
}

/**
 * A shop submits a quote against an open RFQ. The printer identity comes
 * from the authenticated actor; the canonical hash binds every priced field.
 */
export function submitQuote(
  db: Db,
  actor: Actor,
  quoteRequestId: string,
  input: {
    qty: number;
    priceAtoms: number;
    token: string;
    network?: string;
    recipient: string;
    expiresAt: string;
    direction?: string;
  }
): QuoteRow {
  const req = getQuoteRequest(db, quoteRequestId);
  if (req.status !== "OPEN") throw conflict("quote request is closed");
  if (!actor.printerId) throw badRequest("actor is not a printer");
  if (!input.qty || input.qty < 1) throw badRequest("qty must be >= 1");
  if (input.priceAtoms === undefined || input.priceAtoms < 0)
    throw badRequest("priceAtoms must be >= 0");
  if (!input.recipient || !input.token || !input.expiresAt) {
    throw badRequest("recipient, token and expiresAt are required");
  }
  const rev = getRevision(db, req.campaign_id, req.revision_id);
  const network = input.network ?? "SANDBOX";
  const direction = input.direction ?? "pay-printer";
  const hash = computeQuoteHash({
    direction,
    network,
    token: input.token,
    priceAtoms: input.priceAtoms,
    printerId: actor.printerId,
    recipient: input.recipient,
    expiresAt: input.expiresAt,
    revisionDigest: rev.asset_digest,
    qty: input.qty,
  });
  const id = newId("quo");
  try {
    db.prepare(
      `INSERT INTO quotes
         (id, quote_request_id, campaign_id, printer_id, revision_id,
          revision_digest, recipient, qty, price_atoms, token, network,
          direction, dimensions, deadline, expires_at, quote_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      quoteRequestId,
      req.campaign_id,
      actor.printerId,
      req.revision_id,
      rev.asset_digest,
      input.recipient,
      input.qty,
      input.priceAtoms,
      input.token,
      network,
      direction,
      req.dimensions,
      req.deadline,
      input.expiresAt,
      hash,
      nowIso()
    );
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw conflict("identical quote already submitted");
    }
    throw err;
  }
  emit(db, {
    type: "quote.submitted",
    campaignId: req.campaign_id,
    actorId: actor.id,
    entityType: "quote",
    entityId: id,
    payload: { quoteRequestId, printerId: actor.printerId, quoteHash: hash },
  });
  return db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as unknown as QuoteRow;
}

/**
 * Shop uploads a print proof for an RFQ. Digest-addressed: an edited proof
 * is a new object with a new digest (INV-03).
 */
export function uploadProof(
  db: Db,
  actor: Actor,
  objectDir: string,
  quoteRequestId: string,
  input: { assetText?: string; assetBase64?: string }
): ProofRow {
  const req = getQuoteRequest(db, quoteRequestId);
  if (!actor.printerId) throw badRequest("actor is not a printer");
  const bytes =
    input.assetBase64 !== undefined
      ? Buffer.from(input.assetBase64, "base64")
      : Buffer.from(input.assetText ?? "", "utf8");
  if (bytes.length === 0) throw badRequest("proof asset must not be empty");
  const digest = sha256hex(bytes);
  const id = newId("prf");
  const relPath = join(req.campaign_id, `proof-${digest}.bin`);
  mkdirSync(dirname(join(objectDir, relPath)), { recursive: true });
  writeFileSync(join(objectDir, relPath), bytes);
  db.prepare(
    `INSERT INTO proofs
       (id, quote_request_id, campaign_id, printer_id, revision_id,
        proof_digest, asset_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    quoteRequestId,
    req.campaign_id,
    actor.printerId,
    req.revision_id,
    digest,
    relPath,
    nowIso()
  );
  emit(db, {
    type: "proof.uploaded",
    campaignId: req.campaign_id,
    actorId: actor.id,
    entityType: "proof",
    entityId: id,
    payload: { quoteRequestId, printerId: actor.printerId, proofDigest: digest },
  });
  return db.prepare("SELECT * FROM proofs WHERE id = ?").get(id) as unknown as ProofRow;
}

export function getQuote(db: Db, campaignId: string, id: string): QuoteRow {
  const row = db
    .prepare("SELECT * FROM quotes WHERE id = ? AND campaign_id = ?")
    .get(id, campaignId) as QuoteRow | undefined;
  if (!row) throw notFound(`quote '${id}' not found`);
  return row;
}

export function getProof(db: Db, campaignId: string, id: string): ProofRow {
  const row = db
    .prepare("SELECT * FROM proofs WHERE id = ? AND campaign_id = ?")
    .get(id, campaignId) as ProofRow | undefined;
  if (!row) throw notFound(`proof '${id}' not found`);
  return row;
}

/**
 * Buyer approves a bound quote + proof. Validates: quote unexpired, proof
 * covers the quoted revision, and (INV-03) the live canonical hashes still
 * match what is being approved. A repeat approval for the same RFQ stores a
 * new approval with explicit supersession of the prior one.
 */
export function createApproval(
  db: Db,
  actor: Actor,
  campaignId: string,
  input: { quoteId: string; proofId: string }
): ApprovalRow {
  getCampaign(db, actor, campaignId);
  const quote = getQuote(db, campaignId, input.quoteId);
  const proof = getProof(db, campaignId, input.proofId);
  const now = nowIso();

  if (quote.expires_at <= now) {
    throw conflict("quote is expired; a fresh quote is required");
  }
  if (quote.quote_request_id !== proof.quote_request_id) {
    throw conflict("quote and proof belong to different quote requests");
  }
  if (proof.revision_id !== quote.revision_id) {
    throw conflict("proof does not cover the quoted revision");
  }
  // INV-03: recompute the canonical hash — a tampered row cannot be approved.
  const recomputed = computeQuoteHash({
    direction: quote.direction,
    network: quote.network,
    token: quote.token,
    priceAtoms: quote.price_atoms,
    printerId: quote.printer_id,
    recipient: quote.recipient,
    expiresAt: quote.expires_at,
    revisionDigest: quote.revision_digest,
    qty: quote.qty,
  });
  if (recomputed !== quote.quote_hash) {
    throw conflict("quote fields do not match their canonical hash");
  }

  const prior = db
    .prepare(
      "SELECT id FROM approvals WHERE quote_request_id = ? AND superseded_by IS NULL"
    )
    .get(quote.quote_request_id) as { id: string } | undefined;

  const id = newId("apr");
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO approvals
         (id, campaign_id, quote_request_id, quote_id, quote_hash, proof_id,
          proof_hash, revision_id, budget_atoms, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      campaignId,
      quote.quote_request_id,
      quote.id,
      quote.quote_hash,
      proof.id,
      proof.proof_digest,
      quote.revision_id,
      quote.price_atoms,
      actor.id,
      nowIso()
    );
    if (prior) {
      db.prepare("UPDATE approvals SET superseded_by = ? WHERE id = ?").run(
        id,
        prior.id
      );
    }
    db.prepare(
      "UPDATE quote_requests SET status = 'CLOSED' WHERE id = ?"
    ).run(quote.quote_request_id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  emit(db, {
    type: "approval.created",
    campaignId,
    actorId: actor.id,
    entityType: "approval",
    entityId: id,
    payload: {
      quoteId: quote.id,
      quoteHash: quote.quote_hash,
      proofId: proof.id,
      proofHash: proof.proof_digest,
      supersedes: prior?.id ?? null,
    },
  });
  return db
    .prepare("SELECT * FROM approvals WHERE id = ?")
    .get(id) as unknown as ApprovalRow;
}

export function getApproval(db: Db, id: string): ApprovalRow {
  const row = db
    .prepare("SELECT * FROM approvals WHERE id = ?")
    .get(id) as ApprovalRow | undefined;
  if (!row) throw notFound(`approval '${id}' not found`);
  return row;
}

/**
 * Use-time validity: the approval is eligible only while the bound quote is
 * unexpired and the bound proof is still the printer's latest for the RFQ
 * (a changed proof after approval makes no intent eligible — INV-03).
 */
export function approvalEligible(db: Db, approval: ApprovalRow): {
  eligible: boolean;
  reason: string;
} {
  if (approval.superseded_by) {
    return { eligible: false, reason: "approval superseded by a newer approval" };
  }
  const quote = db
    .prepare("SELECT * FROM quotes WHERE id = ?")
    .get(approval.quote_id) as QuoteRow | undefined;
  if (!quote) return { eligible: false, reason: "bound quote missing" };
  if (quote.expires_at <= nowIso()) {
    return { eligible: false, reason: "bound quote is expired" };
  }
  const latestProof = db
    .prepare(
      `SELECT proof_digest FROM proofs
        WHERE quote_request_id = ? AND printer_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(approval.quote_request_id, quote.printer_id) as
    | { proof_digest: string }
    | undefined;
  if (latestProof && latestProof.proof_digest !== approval.proof_hash) {
    return {
      eligible: false,
      reason: "proof changed after approval; a new approval is required",
    };
  }
  return { eligible: true, reason: "approval valid" };
}

export function quoteView(q: QuoteRow): Record<string, unknown> {
  return {
    id: q.id,
    quoteRequestId: q.quote_request_id,
    printerId: q.printer_id,
    revisionId: q.revision_id,
    revisionDigest: q.revision_digest,
    recipient: q.recipient,
    qty: q.qty,
    priceAtoms: q.price_atoms,
    token: q.token,
    network: q.network,
    direction: q.direction,
    dimensions: q.dimensions,
    deadline: q.deadline,
    expiresAt: q.expires_at,
    quoteHash: q.quote_hash,
    createdAt: q.created_at,
  };
}

export function approvalView(a: ApprovalRow, quote?: QuoteRow): Record<string, unknown> {
  return {
    id: a.id,
    quoteRequestId: a.quote_request_id,
    quoteId: a.quote_id,
    quoteHash: a.quote_hash,
    proofId: a.proof_id,
    proofHash: a.proof_hash,
    revisionId: a.revision_id,
    budgetAtoms: a.budget_atoms,
    approvedBy: a.actor_id,
    supersededBy: a.superseded_by,
    createdAt: a.created_at,
    selected: quote ? quoteView(quote) : undefined,
  };
}
