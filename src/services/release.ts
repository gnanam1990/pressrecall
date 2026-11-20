import type { Db } from "../db/connection.js";
import type { Actor } from "../http/auth.js";
import { conflict } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import { emit } from "./events.js";
import { getCampaign } from "./campaigns.js";
import type { IntentRow, SpendRow } from "./settlement.js";

interface ReleaseRow {
  id: string;
  campaign_id: string;
  public_token: string;
  status: string;
  report: string;
  public_report: string | null;
  released_by: string;
  created_at: string;
}

const isSandboxLedger = (label: string | null | undefined): boolean =>
  !label || label.startsWith("SANDBOX");

interface PlacementLite {
  id: string;
  site_code: string;
  site_label: string;
}

interface PlanLite {
  placement_id: string;
  target_revision_id: string;
  state: string;
  reason: string;
}

function maskRecipient(r: string): string {
  return r.length <= 6 ? "…" : `${r.slice(0, 4)}…${r.slice(-2)}`;
}

/**
 * Payment verification: re-derive each spend's binding from the recorded
 * receipt, independently of the spend row's own status flag.
 */
function verifyPayments(db: Db, campaignId: string) {
  const spends = db
    .prepare("SELECT * FROM spends WHERE campaign_id = ?")
    .all(campaignId) as unknown as SpendRow[];
  return spends.map((s) => {
    const receipt = db
      .prepare(
        "SELECT tx_hash, raw FROM spend_receipts WHERE spend_id = ? ORDER BY id"
      )
      .all(s.id) as unknown as { tx_hash: string; raw: string }[];
    const parsed = receipt.map((r) => JSON.parse(r.raw) as Record<string, unknown>);
    const matched =
      s.status === "CONFIRMED" &&
      parsed.length === 1 &&
      parsed[0]!.txHash === s.tx_hash &&
      parsed[0]!.amountAtoms === s.amount_atoms &&
      parsed[0]!.toAccount === s.recipient &&
      parsed[0]!.token === s.token;
    return {
      spendId: s.id,
      status: s.status,
      ledger: s.ledger_label,
      txHash: s.tx_hash,
      token: s.token,
      amountAtoms: s.amount_atoms,
      recipient: s.recipient,
      fundedBy: s.funded_by,
      receiptMatched: matched,
    };
  });
}

/**
 * Acceptance report. `audience: 'public'` strips private detail: contact
 * fields, uploader identities, evidence notes/paths, site labels, session
 * ids — keeping digests, codes, states, tx hashes and aggregates.
 *
 * `ledgerLabel` is the configured adapter's identity — never hardcoded.
 * Attribution is ledger-aware: a spend marked fundedBy 'external' on a
 * SANDBOX ledger is a buyer label only — it cannot prove independent use
 * and is counted separately, not as adoption.
 */
export function buildReport(
  db: Db,
  campaignId: string,
  audience: "public" | "private",
  ledgerLabel: string
): Record<string, unknown> {
  const campaign = db
    .prepare("SELECT * FROM campaigns WHERE id = ?")
    .get(campaignId) as {
    id: string;
    name: string;
    budget_cap_atoms: number;
    budget_token: string;
    status: string;
  };
  const placements = db
    .prepare("SELECT id, site_code, site_label FROM placements WHERE campaign_id = ? ORDER BY site_code")
    .all(campaignId) as unknown as PlacementLite[];
  const planItems = db
    .prepare(
      "SELECT placement_id, target_revision_id, state, reason FROM plan_items WHERE campaign_id = ?"
    )
    .all(campaignId) as unknown as PlanLite[];
  const itemByPlacement = new Map(planItems.map((i) => [i.placement_id, i]));
  const targetDigest = new Map(
    (
      db
        .prepare("SELECT id, asset_digest FROM revisions WHERE campaign_id = ?")
        .all(campaignId) as unknown as { id: string; asset_digest: string }[]
    ).map((r) => [r.id, r.asset_digest])
  );

  const sites = placements.map((p) => {
    const item = itemByPlacement.get(p.id);
    const evCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM evidence WHERE placement_id = ?")
        .get(p.id) as { n: number }
    ).n;
    const deliveries = db
      .prepare(
        "SELECT qty, revision_id FROM deliveries WHERE placement_id = ? ORDER BY created_at"
      )
      .all(p.id) as unknown as { qty: number; revision_id: string }[];
    const base = {
      siteCode: p.site_code,
      planState: item?.state ?? "UNKNOWN",
      targetRevisionId: item?.target_revision_id ?? null,
      targetDigest: item ? targetDigest.get(item.target_revision_id) ?? null : null,
      evidenceCount: evCount,
      deliveries: deliveries.map((d) => ({
        qty: d.qty,
        revisionId: d.revision_id,
        onTarget: d.revision_id === item?.target_revision_id,
      })),
    };
    return audience === "private"
      ? { ...base, siteLabel: p.site_label, reason: item?.reason ?? null }
      : base;
  });

  const payments = verifyPayments(db, campaignId);
  const intents = db
    .prepare("SELECT * FROM order_intents WHERE campaign_id = ?")
    .all(campaignId) as unknown as IntentRow[];

  const confirmed = payments.filter((p) => p.status === "CONFIRMED");
  const settledAtoms = confirmed.reduce((a, p) => a + p.amountAtoms, 0);
  const live = confirmed.filter((p) => !isSandboxLedger(p.ledger));
  const sandbox = confirmed.filter((p) => isSandboxLedger(p.ledger));
  const liveSettledAtoms = live.reduce((a, p) => a + p.amountAtoms, 0);
  const sandboxSettledAtoms = sandbox.reduce((a, p) => a + p.amountAtoms, 0);
  // Independent usage requires BOTH a live ledger AND non-team funding.
  // A buyer-applied 'external' label on sandbox rows is claimed, not proven.
  const independentAtoms = live
    .filter((p) => p.fundedBy !== "team")
    .reduce((a, p) => a + p.amountAtoms, 0);
  const claimedIndependentAtoms = sandbox
    .filter((p) => p.fundedBy !== "team")
    .reduce((a, p) => a + p.amountAtoms, 0);
  const teamFundedAtoms = settledAtoms - independentAtoms - claimedIndependentAtoms;

  const counts = {
    sitesTotal: placements.length,
    sitesVerified: sites.filter((s) => s.planState === "VERIFIED").length,
    sitesOpen: sites.filter(
      (s) => !["VERIFIED", "EXCEPTION"].includes(String(s.planState))
    ).length,
    sitesException: sites.filter((s) => s.planState === "EXCEPTION").length,
    deliveriesTotal: sites.reduce((a, s) => a + (s.deliveries as unknown[]).length, 0),
    deliveriesOnTarget: sites.reduce(
      (a, s) =>
        a + (s.deliveries as { onTarget: boolean }[]).filter((d) => d.onTarget).length,
      0
    ),
    intentsTotal: intents.length,
    spendsConfirmed: confirmed.length,
    spendsAmbiguous: payments.filter((p) => p.status === "AMBIGUOUS").length,
    spendsFailed: payments.filter((p) => p.status === "DEFINITIVELY_FAILED").length,
  };

  // Redirect-corrected verified items are physical reprints avoided.
  const avoidedUnits = planItems.filter(
    (i) => i.state === "VERIFIED" && /redirect/i.test(i.reason ?? "")
  ).length;

  const unresolved = sites
    .filter((s) => !["VERIFIED", "EXCEPTION"].includes(String(s.planState)))
    .map((s) => s.siteCode);
  const exceptions = [
    ...sites
      .filter((s) => s.planState === "EXCEPTION")
      .map((s) => ({ type: "site_exception", siteCode: s.siteCode })),
    ...intents
      .filter((i) => i.state === "DISPUTED")
      .map((i) => ({ type: "disputed_job", intentId: i.id })),
    ...payments
      .filter((p) => p.status === "AMBIGUOUS")
      .map((p) => ({ type: "ambiguous_spend", spendId: p.spendId })),
  ];

  const publicPayments = payments.map((p) => ({
    status: p.status,
    ledger: p.ledger,
    txHash: p.txHash,
    token: p.token,
    amountAtoms: p.amountAtoms,
    recipient: audience === "private" ? p.recipient : maskRecipient(p.recipient),
    fundedBy: p.fundedBy,
    receiptMatched: p.receiptMatched,
  }));

  return {
    campaignId: campaign.id,
    name: campaign.name,
    state: campaign.status,
    generatedAt: nowIso(),
    ledger: ledgerLabel,
    budget: {
      capAtoms: campaign.budget_cap_atoms,
      token: campaign.budget_token,
    },
    costs: {
      settledAtoms,
      sandboxSettledAtoms,
      liveSettledAtoms,
      committedAtoms: intents
        .filter((i) => i.state !== "DISPUTED")
        .reduce((a, i) => a + i.amount_atoms, 0),
      payments: publicPayments,
    },
    attribution: {
      independentAtoms,
      claimedIndependentAtoms,
      teamFundedAtoms,
      evidenceClass:
        liveSettledAtoms > 0
          ? "LIVE"
          : sandboxSettledAtoms > 0
            ? "SANDBOX_ONLY"
            : "NONE",
      note: "independent usage requires a live ledger plus non-team funding; sandbox rows are labeled, not proven",
    },
    counts,
    avoidedUnits,
    unresolved,
    exceptions,
    sites,
  };
}

/**
 * Publish the acceptance release. Requires every site VERIFIED, or an
 * explicit `allowExceptions` to publish as CLOSED_WITH_EXCEPTIONS with
 * each exception listed. Returns the private report and the shareable
 * public token.
 */
export function releaseCampaign(
  db: Db,
  actor: Actor,
  campaignId: string,
  ledgerLabel: string,
  input: { allowExceptions?: boolean }
): { release: ReleaseRow; report: Record<string, unknown> } {
  getCampaign(db, actor, campaignId);
  const existing = db
    .prepare("SELECT * FROM releases WHERE campaign_id = ?")
    .get(campaignId) as ReleaseRow | undefined;
  if (existing) {
    return { release: existing, report: JSON.parse(existing.report) };
  }
  const report = buildReport(db, campaignId, "private", ledgerLabel);
  const counts = report.counts as { sitesTotal: number };
  if (counts.sitesTotal === 0) {
    throw conflict("campaign has no sites — nothing to release");
  }
  const unresolved = (report.unresolved as string[]).length;
  const exceptions = report.exceptions as unknown[];
  if ((unresolved > 0 || exceptions.length > 0) && !input.allowExceptions) {
    throw conflict(
      `${unresolved} unresolved site(s) and ${exceptions.length} exception(s) — release requires explicit exception signoff (allowExceptions)`
    );
  }
  const status =
    unresolved === 0 && exceptions.length === 0 ? "VERIFIED" : "CLOSED_WITH_EXCEPTIONS";
  // Snapshots carry the POST-transition status and are persisted atomically
  // with the campaign transition; the public bundle never recomputes.
  report.state = status;
  const publicSnapshot = {
    ...buildReport(db, campaignId, "public", ledgerLabel),
    state: status,
    redaction:
      "PUBLIC: no site labels, contacts, uploader ids, evidence notes/paths or session material",
  };

  const id = newId("rel");
  const publicToken = `pub_${newId("").replace(/[^a-z0-9]/gi, "")}${Math.random().toString(36).slice(2, 14)}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE campaigns SET status = ? WHERE id = ?").run(status, campaignId);
    db.prepare(
      `INSERT INTO releases (id, campaign_id, public_token, status, report, public_report, released_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      campaignId,
      publicToken,
      status,
      JSON.stringify(report),
      JSON.stringify(publicSnapshot),
      actor.id,
      nowIso()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  emit(db, {
    type: "release.published",
    campaignId,
    actorId: actor.id,
    entityType: "campaign",
    entityId: campaignId,
    payload: { status, unresolved, exceptionCount: exceptions.length },
  });
  const release = db
    .prepare("SELECT * FROM releases WHERE id = ?")
    .get(id) as unknown as ReleaseRow;
  return { release, report };
}

/**
 * Serve the persisted public snapshot — immutable at publication. The
 * bundle does NOT recompute live data, so post-release state changes can
 * never silently alter what was shared with the client.
 */
export function publicBundle(db: Db, publicToken: string): Record<string, unknown> | null {
  const release = db
    .prepare("SELECT * FROM releases WHERE public_token = ?")
    .get(publicToken) as ReleaseRow | undefined;
  if (!release) return null;
  const snapshot = JSON.parse(release.public_report ?? release.report) as Record<
    string,
    unknown
  >;
  return { ...snapshot, releasedAt: release.created_at, status: release.status };
}
