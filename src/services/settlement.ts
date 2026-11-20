import type { Db } from "../db/connection.js";
import type { Actor } from "../http/auth.js";
import { badRequest, conflict, notFound, policyDenied } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import { digestOf, sha256hex } from "../domain/canon.js";
import { emit } from "./events.js";
import { getCampaign } from "./campaigns.js";
import { approvalEligible, getApproval, getQuote, type ApprovalRow } from "./quotes.js";
import {
  AmbiguousError,
  PolicyDenialError,
  type Receipt,
  type SignerAdapter,
} from "../chain/adapter.js";

export interface GrantRow {
  id: string;
  tenant_id: string;
  campaign_id: string;
  session_id: string;
  max_amount_atoms: number;
  token: string;
  network: string;
  allowed_payees: string;
  status: string;
  granted_by: string;
  revoked_by: string | null;
  revoked_at: string | null;
  session_data: string | null;
  created_at: string;
}

export interface IntentRow {
  id: string;
  campaign_id: string;
  approval_id: string;
  quote_request_id: string;
  quote_hash: string;
  client_key: string;
  intent_digest: string;
  shop_ref: string | null;
  state: string;
  amount_atoms: number;
  token: string;
  recipient: string;
  created_by: string;
  created_at: string;
}

export interface SpendRow {
  id: string;
  intent_id: string;
  campaign_id: string;
  network: string;
  token: string;
  amount_atoms: number;
  recipient: string;
  session_id: string;
  grant_id: string;
  tx_hash: string | null;
  status: string;
  funded_by: string;
  ledger_label: string;
  calls_id: string | null;
  created_at: string;
  updated_at: string;
}

export function createGrant(
  db: Db,
  actor: Actor,
  campaignId: string,
  input: {
    sessionId: string;
    maxAmountAtoms: number;
    token: string;
    network: string;
    allowedPayees: string[];
    sessionData?: string;
  }
): GrantRow {
  getCampaign(db, actor, campaignId);
  if (!input.sessionId || !input.token || !input.network) {
    throw badRequest("sessionId, token and network are required");
  }
  if (!input.maxAmountAtoms || input.maxAmountAtoms <= 0) {
    throw badRequest("maxAmountAtoms must be > 0");
  }
  if (!Array.isArray(input.allowedPayees) || input.allowedPayees.length === 0) {
    throw badRequest("allowedPayees must be a non-empty list");
  }
  const id = newId("grt");
  db.prepare(
    `INSERT INTO grants
       (id, tenant_id, campaign_id, session_id, max_amount_atoms, token,
        network, allowed_payees, granted_by, session_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    actor.tenantId,
    campaignId,
    input.sessionId,
    input.maxAmountAtoms,
    input.token,
    input.network,
    JSON.stringify(input.allowedPayees),
    actor.id,
    input.sessionData ?? null,
    nowIso()
  );
  emit(db, {
    type: "grant.created",
    campaignId,
    actorId: actor.id,
    entityType: "grant",
    entityId: id,
    payload: { sessionId: input.sessionId, maxAmountAtoms: input.maxAmountAtoms },
  });
  return db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as unknown as GrantRow;
}

export function revokeGrant(db: Db, actor: Actor, grantId: string): GrantRow {
  const row = db
    .prepare("SELECT * FROM grants WHERE id = ?")
    .get(grantId) as GrantRow | undefined;
  if (!row || row.tenant_id !== actor.tenantId) {
    throw notFound(`grant '${grantId}' not found`);
  }
  if (row.status === "REVOKED") return row;
  db.prepare(
    "UPDATE grants SET status = 'REVOKED', revoked_by = ?, revoked_at = ? WHERE id = ?"
  ).run(actor.id, nowIso(), grantId);
  emit(db, {
    type: "grant.revoked",
    campaignId: row.campaign_id,
    actorId: actor.id,
    entityType: "grant",
    entityId: grantId,
    payload: { sessionId: row.session_id },
  });
  return db.prepare("SELECT * FROM grants WHERE id = ?").get(grantId) as unknown as GrantRow;
}

function intentDigest(input: {
  approvalId: string;
  quoteHash: string;
  clientKey: string;
  amountAtoms: number;
  recipient: string;
  token: string;
}): string {
  return digestOf({
    approvalId: input.approvalId,
    quoteHash: input.quoteHash,
    clientKey: input.clientKey,
    amountAtoms: input.amountAtoms,
    recipient: input.recipient,
    token: input.token,
  });
}

/** Deterministic ledger identity: resends of one intent dedupe under this key. */
export function intentKeyFor(campaignId: string, clientKey: string): string {
  return sha256hex(`pressrecall:${campaignId}:${clientKey}`);
}

/**
 * Budget committed to this campaign: every intent holds its reservation
 * until its spend definitively fails; a confirmed spend is the same money
 * counted once. Evaluated inside a serializable transaction (NFR-01).
 */
function committedAtoms(db: Db, campaignId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(i.amount_atoms), 0) AS total
         FROM order_intents i
         LEFT JOIN spends s ON s.intent_id = i.id
        WHERE i.campaign_id = ?
          AND (s.id IS NULL OR s.status != 'DEFINITIVELY_FAILED')`
    )
    .get(campaignId) as { total: number };
  return row.total;
}

/**
 * Reserve a pending order against an approval and client key. Approval
 * validity and the campaign budget cap are checked inside one serializable
 * transaction; a byte-equivalent retry returns the original intent, a
 * changed payload under the same key conflicts.
 */
export function createOrderIntent(
  db: Db,
  actor: Actor,
  campaignId: string,
  input: { approvalId: string; clientKey: string }
): { intent: IntentRow; created: boolean } {
  getCampaign(db, actor, campaignId);
  if (!input.clientKey) throw badRequest("clientKey is required");
  const approval = getApproval(db, input.approvalId);
  if (approval.campaign_id !== campaignId) {
    throw conflict("approval belongs to a different campaign");
  }
  const quote = getQuote(db, campaignId, approval.quote_id);
  const digest = intentDigest({
    approvalId: approval.id,
    quoteHash: approval.quote_hash,
    clientKey: input.clientKey,
    amountAtoms: quote.price_atoms,
    recipient: quote.recipient,
    token: quote.token,
  });

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        "SELECT * FROM order_intents WHERE campaign_id = ? AND client_key = ?"
      )
      .get(campaignId, input.clientKey) as IntentRow | undefined;
    if (existing) {
      if (existing.intent_digest === digest) {
        db.exec("COMMIT");
        return { intent: existing, created: false };
      }
      db.exec("ROLLBACK");
      throw conflict("clientKey already used with a different intent payload");
    }

    const elig = approvalEligible(db, approval);
    if (!elig.eligible) {
      db.exec("ROLLBACK");
      throw conflict(`approval not eligible: ${elig.reason}`);
    }

    const campaign = getCampaign(db, actor, campaignId);
    const committed = committedAtoms(db, campaignId);
    if (committed + quote.price_atoms > campaign.budget_cap_atoms) {
      db.exec("ROLLBACK");
      throw conflict(
        `campaign budget cap exceeded: committed ${committed} + ${quote.price_atoms} > cap ${campaign.budget_cap_atoms}`
      );
    }

    const id = newId("int");
    db.prepare(
      `INSERT INTO order_intents
         (id, campaign_id, approval_id, quote_request_id, quote_hash,
          client_key, intent_digest, state, amount_atoms, token, recipient,
          created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, ?)`
    ).run(
      id,
      campaignId,
      approval.id,
      approval.quote_request_id,
      approval.quote_hash,
      input.clientKey,
      digest,
      quote.price_atoms,
      quote.token,
      quote.recipient,
      actor.id,
      nowIso()
    );
    db.exec("COMMIT");
    emit(db, {
      type: "order_intent.created",
      campaignId,
      actorId: actor.id,
      entityType: "order_intent",
      entityId: id,
      payload: { clientKey: input.clientKey, amountAtoms: quote.price_atoms },
    });
    return {
      intent: db.prepare("SELECT * FROM order_intents WHERE id = ?").get(id) as unknown as IntentRow,
      created: true,
    };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/**
 * The authenticated shop reserves an intent under its own immutable order
 * reference. Only the shop that owns the bound quote may reserve.
 */
export function reserveIntent(
  db: Db,
  actor: Actor,
  intentId: string,
  input: { shopRef: string }
): IntentRow {
  if (!input.shopRef) throw badRequest("shopRef is required");
  const intent = db
    .prepare("SELECT * FROM order_intents WHERE id = ?")
    .get(intentId) as IntentRow | undefined;
  if (!intent) throw notFound(`order intent '${intentId}' not found`);
  if (intent.state !== "REQUESTED") {
    throw conflict(`intent is '${intent.state}', not REQUESTED`);
  }
  const approval = getApproval(db, intent.approval_id);
  const quote = getQuote(db, intent.campaign_id, approval.quote_id);
  if (actor.printerId !== quote.printer_id) {
    throw policyDenied("only the shop that owns the quote may reserve this job");
  }
  try {
    db.prepare(
      "UPDATE order_intents SET state = 'RESERVED', shop_ref = ? WHERE id = ?"
    ).run(input.shopRef, intentId);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw conflict("shopRef already in use");
    }
    throw err;
  }
  emit(db, {
    type: "order_intent.reserved",
    campaignId: intent.campaign_id,
    actorId: actor.id,
    entityType: "order_intent",
    entityId: intentId,
    payload: { shopRef: input.shopRef },
  });
  return db
    .prepare("SELECT * FROM order_intents WHERE id = ?")
    .get(intentId) as unknown as IntentRow;
}

function spendOf(db: Db, intentId: string): SpendRow | undefined {
  return db.prepare("SELECT * FROM spends WHERE intent_id = ?").get(intentId) as
    | SpendRow
    | undefined;
}

function findGrant(db: Db, input: {
  grantId: string | undefined;
  tenantId: string;
  campaignId: string;
  amountAtoms: number;
  token: string;
  network: string;
  recipient: string;
}): GrantRow {
  const rows = db
    .prepare(
      "SELECT * FROM grants WHERE campaign_id = ? AND tenant_id = ? AND status = 'ACTIVE'"
    )
    .all(input.campaignId, input.tenantId) as unknown as GrantRow[];
  const candidates = input.grantId
    ? rows.filter((g) => g.id === input.grantId)
    : rows;
  for (const g of candidates) {
    const payees = JSON.parse(g.allowed_payees) as string[];
    if (!payees.includes(input.recipient)) continue;
    if (g.token !== input.token || g.network !== input.network) continue;
    const used = db
      .prepare(
        `SELECT COALESCE(SUM(amount_atoms),0) AS total FROM spends
          WHERE grant_id = ? AND status != 'DEFINITIVELY_FAILED'`
      )
      .get(g.id) as { total: number };
    if (used.total + input.amountAtoms > g.max_amount_atoms) continue;
    return g;
  }
  if (input.grantId) {
    throw policyDenied(
      "no active grant matches the requested grant, scope, payee, token or remaining allowance"
    );
  }
  throw policyDenied(
    "no active grant covers this payment scope (payee, token, network, amount)"
  );
}

/**
 * Execute the approved payment through the signer adapter. Order: verify
 * intent RESERVED + approval still eligible + active scoped grant, write the
 * spend leg PENDING and the outbox row in one transaction, then broadcast.
 * Ambiguous responses freeze the leg (INV-04); receipts reconcile by
 * observed identity.
 */
export async function executeIntent(
  db: Db,
  actor: Actor,
  intentId: string,
  adapter: SignerAdapter,
  input: { grantId?: string; fundedBy?: string } = {}
): Promise<SpendRow> {
  const intent = db
    .prepare("SELECT * FROM order_intents WHERE id = ?")
    .get(intentId) as IntentRow | undefined;
  if (!intent) throw notFound(`order intent '${intentId}' not found`);
  if (intent.state !== "RESERVED") {
    throw conflict(`intent is '${intent.state}'; shop reservation required before settlement`);
  }
  const approval = getApproval(db, intent.approval_id);
  const elig = approvalEligible(db, approval);
  if (!elig.eligible) {
    throw conflict(`approval not eligible at use time: ${elig.reason}`);
  }
  const quote = getQuote(db, intent.campaign_id, approval.quote_id);

  const existing = spendOf(db, intentId);
  if (existing) {
    if (existing.status === "DEFINITIVELY_FAILED") {
      // A second signature requires an independently established unsent
      // state (definitive failure, verified above) AND a refreshed grant.
      if (!input.grantId || input.grantId === existing.grant_id) {
        throw conflict(
          "retry after definitive failure requires a refreshed grant"
        );
      }
    } else {
      throw conflict(
        `intent has a ${existing.status} settlement leg; cannot allocate a second settlement (INV-04)`
      );
    }
  }

  const grant = findGrant(db, {
    grantId: input.grantId,
    tenantId: actor.tenantId,
    campaignId: intent.campaign_id,
    amountAtoms: intent.amount_atoms,
    token: quote.token,
    network: quote.network,
    recipient: quote.recipient,
  });

  const spendId = newId("spn");
  const intentKey = intentKeyFor(intent.campaign_id, intent.client_key);
  const fundedBy = input.fundedBy ?? "team";

  db.exec("BEGIN IMMEDIATE");
  try {
    if (existing) {
      db.prepare(
        `UPDATE spends
           SET grant_id = ?, session_id = ?, status = 'PENDING', tx_hash = NULL,
               funded_by = ?, ledger_label = ?, updated_at = ?
         WHERE id = ?`
      ).run(grant.id, grant.session_id, fundedBy, adapter.label, nowIso(), existing.id);
    } else {
      db.prepare(
        `INSERT INTO spends
           (id, intent_id, campaign_id, network, token, amount_atoms,
            recipient, session_id, grant_id, status, funded_by, ledger_label,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`
      ).run(
        spendId,
        intentId,
        intent.campaign_id,
        quote.network,
        quote.token,
        intent.amount_atoms,
        quote.recipient,
        grant.session_id,
        grant.id,
        fundedBy,
        adapter.label,
        nowIso(),
        nowIso()
      );
    }
    db.prepare(
      "INSERT INTO outbox (type, payload, created_at) VALUES ('spend.dispatch', ?, ?)"
    ).run(JSON.stringify({ spendId: existing?.id ?? spendId, intentKey }), nowIso());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const legId = existing?.id ?? spendId;
  emit(db, {
    type: "spend.pending",
    campaignId: intent.campaign_id,
    actorId: actor.id,
    entityType: "spend",
    entityId: legId,
    payload: { intentId, grantId: grant.id, ledger: adapter.label },
  });

  try {
    const receipt = await adapter.send({
      intentKey,
      network: quote.network,
      token: quote.token,
      amountAtoms: intent.amount_atoms,
      fromAccount: `tenant:${actor.tenantId}`,
      toAccount: quote.recipient,
      sessionId: grant.session_id,
      grantId: grant.id,
      fundedBy,
      sessionData: grant.session_data ?? undefined,
    });
    applyReceipt(db, legId, receipt, actor.id);
    return db.prepare("SELECT * FROM spends WHERE id = ?").get(legId) as unknown as SpendRow;
  } catch (err) {
    if (err instanceof AmbiguousError) {
      db.prepare(
        "UPDATE spends SET status = 'AMBIGUOUS', calls_id = COALESCE(?, calls_id), updated_at = ? WHERE id = ?"
      ).run(err.handle ?? null, nowIso(), legId);
      emit(db, {
        type: "spend.ambiguous",
        campaignId: intent.campaign_id,
        actorId: actor.id,
        entityType: "spend",
        entityId: legId,
        payload: { intentKey, message: err.message },
      });
      return db.prepare("SELECT * FROM spends WHERE id = ?").get(legId) as unknown as SpendRow;
    }
    if (err instanceof PolicyDenialError) {
      // Nothing was broadcast: remove the pending leg, keep reservation.
      db.prepare("DELETE FROM spends WHERE id = ?").run(legId);
      db.prepare(
        "UPDATE outbox SET status = 'FAILED' WHERE payload LIKE ? AND status = 'PENDING'"
      ).run(`%"spendId":"${legId}"%`);
      emit(db, {
        type: "spend.denied",
        campaignId: intent.campaign_id,
        actorId: actor.id,
        entityType: "order_intent",
        entityId: intentId,
        payload: { reason: err.message, grantId: grant.id },
      });
      throw policyDenied(`settlement denied: ${err.message}`);
    }
    db.prepare(
      "UPDATE spends SET status = 'DEFINITIVELY_FAILED', updated_at = ? WHERE id = ?"
    ).run(nowIso(), legId);
    emit(db, {
      type: "spend.failed",
      campaignId: intent.campaign_id,
      actorId: actor.id,
      entityType: "spend",
      entityId: legId,
      payload: { message: String((err as Error).message) },
    });
    return db.prepare("SELECT * FROM spends WHERE id = ?").get(legId) as unknown as SpendRow;
  }
}

function applyReceipt(
  db: Db,
  spendId: string,
  receipt: Receipt,
  actorId: string
): void {
  const spend = db
    .prepare("SELECT * FROM spends WHERE id = ?")
    .get(spendId) as unknown as SpendRow;
  // Receipt must match the intended leg exactly. Network identity is the
  // leg's declared network or the adapter's chain label (recovery paths
  // report the label).
  if (
    (receipt.network !== spend.network &&
      receipt.network !== spend.ledger_label) ||
    receipt.token !== spend.token ||
    receipt.toAccount !== spend.recipient ||
    receipt.amountAtoms !== spend.amount_atoms
  ) {
    throw conflict(
      "receipt does not match spend leg (network/token/recipient/amount)"
    );
  }
  try {
    db.prepare(
      `INSERT INTO spend_receipts (spend_id, tx_hash, raw, observed_at)
       VALUES (?, ?, ?, ?)`
    ).run(spendId, receipt.txHash, JSON.stringify(receipt), nowIso());
  } catch (err) {
    if (String(err).includes("idx_spend_receipts_txhash")) {
      throw conflict("receipt already attached to another spend");
    }
    if (String(err).includes("UNIQUE")) {
      // Same receipt replayed for the same spend — idempotent, no second row.
    } else {
      throw err;
    }
  }
  db.prepare(
    "UPDATE spends SET status = 'CONFIRMED', tx_hash = ?, funded_by = ?, updated_at = ? WHERE id = ?"
  ).run(receipt.txHash, receipt.fundedBy, nowIso(), spendId);
  db.prepare(
    "UPDATE order_intents SET state = 'CONFIRMED' WHERE id = ? AND state = 'RESERVED'"
  ).run(spend.intent_id);
  emit(db, {
    type: "spend.confirmed",
    campaignId: spend.campaign_id,
    actorId,
    entityType: "spend",
    entityId: spendId,
    payload: { txHash: receipt.txHash, amountAtoms: receipt.amountAtoms },
  });
}

/**
 * Reconcile an ambiguous/submitted leg. Looks up the known tx hash first,
 * then the deterministic intent key. A replayed receipt never creates a
 * second cost row; unresolved legs stay ambiguous for escalation.
 */
export async function reconcileSpend(
  db: Db,
  actor: Actor,
  spendId: string,
  adapter: SignerAdapter
): Promise<{ status: string; txHash: string | null }> {
  const spend = db
    .prepare("SELECT * FROM spends WHERE id = ?")
    .get(spendId) as SpendRow | undefined;
  if (!spend) throw notFound(`spend '${spendId}' not found`);
  if (spend.status === "CONFIRMED") {
    return { status: "CONFIRMED", txHash: spend.tx_hash };
  }
  if (spend.status === "DEFINITIVELY_FAILED") {
    throw conflict("spend definitively failed; reconciliation closed");
  }
  const intent = db
    .prepare("SELECT * FROM order_intents WHERE id = ?")
    .get(spend.intent_id) as unknown as IntentRow;
  const intentKey = intentKeyFor(intent.campaign_id, intent.client_key);

  let receipt: Receipt | null = null;
  if (spend.tx_hash) {
    receipt = await adapter.lookupByTxHash(spend.tx_hash);
  }
  if (!receipt && spend.calls_id && adapter.lookupByHandle) {
    receipt = await adapter.lookupByHandle(spend.calls_id);
  }
  if (!receipt) {
    receipt = await adapter.lookupByIntentKey(intentKey);
  }
  if (!receipt) {
    emit(db, {
      type: "spend.unresolved",
      campaignId: spend.campaign_id,
      actorId: actor.id,
      entityType: "spend",
      entityId: spendId,
      payload: { intentKey, note: "escalated — no ledger record found" },
    });
    return { status: spend.status, txHash: spend.tx_hash };
  }
  applyReceipt(db, spendId, receipt, actor.id);
  const updated = db
    .prepare("SELECT * FROM spends WHERE id = ?")
    .get(spendId) as unknown as SpendRow;
  return { status: updated.status, txHash: updated.tx_hash };
}

export function intentView(i: IntentRow): Record<string, unknown> {
  return {
    id: i.id,
    campaignId: i.campaign_id,
    approvalId: i.approval_id,
    quoteRequestId: i.quote_request_id,
    quoteHash: i.quote_hash,
    clientKey: i.client_key,
    shopRef: i.shop_ref,
    state: i.state,
    amountAtoms: i.amount_atoms,
    token: i.token,
    recipient: i.recipient,
    createdBy: i.created_by,
    createdAt: i.created_at,
  };
}

export function spendView(s: SpendRow): Record<string, unknown> {
  return {
    id: s.id,
    intentId: s.intent_id,
    network: s.network,
    token: s.token,
    amountAtoms: s.amount_atoms,
    recipient: s.recipient,
    sessionId: s.session_id,
    grantId: s.grant_id,
    txHash: s.tx_hash,
    status: s.status,
    fundedBy: s.funded_by,
    ledger: s.ledger_label,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

export function grantView(g: GrantRow): Record<string, unknown> {
  return {
    id: g.id,
    campaignId: g.campaign_id,
    sessionId: g.session_id,
    maxAmountAtoms: g.max_amount_atoms,
    token: g.token,
    network: g.network,
    allowedPayees: JSON.parse(g.allowed_payees),
    status: g.status,
    grantedBy: g.granted_by,
    revokedBy: g.revoked_by,
    revokedAt: g.revoked_at,
    createdAt: g.created_at,
  };
}

export type { ApprovalRow };
