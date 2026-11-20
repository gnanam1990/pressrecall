import type { Db } from "../db/connection.js";
import { qget, qrun } from "../db/query.js";
import { sha256hex, canonicalize } from "../domain/canon.js";
import { nowIso } from "../domain/ids.js";
import {
  AmbiguousError,
  PolicyDenialError,
  type Receipt,
  type SendRequest,
  type SignerAdapter,
} from "./adapter.js";

interface LedgerRow {
  tx_hash: string;
  intent_key: string;
  network: string;
  token: string;
  amount_atoms: number;
  from_account: string;
  to_account: string;
  funded_by: string;
  block: number;
}

function toReceipt(r: LedgerRow): Receipt {
  return {
    txHash: r.tx_hash,
    intentKey: r.intent_key,
    network: r.network,
    token: r.token,
    amountAtoms: r.amount_atoms,
    fromAccount: r.from_account,
    toAccount: r.to_account,
    fundedBy: r.funded_by,
    block: r.block,
    label: "SANDBOX",
  };
}

/**
 * Durable local ledger, clearly labeled SANDBOX. Write-once rows keyed by
 * deterministic intent key — a second send of the same intent cannot create
 * a second charge. `dropResponse` simulates a lost broadcast response for
 * ambiguity testing; `grantStatus` reads the grants table at use time so a
 * revoked grant is denied even with unchanged app credentials.
 */
export class SandboxChainAdapter implements SignerAdapter {
  readonly label = "SANDBOX";
  readonly attribution = "OFFCHAIN" as const;
  /** Test/dev fault injection: broadcast writes, then the response is lost. */
  dropResponse = false;

  constructor(private db: Db) {}

  async send(req: SendRequest): Promise<Receipt> {
    // Use-time grant check — never trust a cached authorization.
    const grant = qget<{ status: string }>(
      this.db,
      "SELECT status FROM grants WHERE id = ?",
      req.grantId
    );
    if (!grant || grant.status !== "ACTIVE") {
      throw new PolicyDenialError("grant is not active");
    }

    const txHash = sha256hex(
      canonicalize({
        intentKey: req.intentKey,
        from: req.fromAccount,
        to: req.toAccount,
        amountAtoms: req.amountAtoms,
        token: req.token,
        network: req.network,
      })
    );
    const block = Number(
      (qget<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM sandbox_ledger")?.n ?? 0) + 1
    );
    try {
      qrun(
        this.db,
        `INSERT INTO sandbox_ledger
           (tx_hash, intent_key, network, token, amount_atoms, from_account,
            to_account, funded_by, block, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        txHash,
        req.intentKey,
        req.network,
        req.token,
        req.amountAtoms,
        req.fromAccount,
        req.toAccount,
        req.fundedBy,
        block,
        nowIso()
      );
    } catch (err) {
      if (String(err).includes("UNIQUE") && String(err).includes("intent_key")) {
        // Deterministically the same intent — this is a resend, not a charge.
        const existing = await this.lookupByIntentKey(req.intentKey);
        if (existing) return existing;
      }
      throw err;
    }

    if (this.dropResponse) {
      throw new AmbiguousError("broadcast response lost (SANDBOX fault injection)", req.intentKey);
    }
    const row = qget<LedgerRow>(
      this.db,
      "SELECT * FROM sandbox_ledger WHERE tx_hash = ?",
      txHash
    );
    return toReceipt(row!);
  }

  async lookupByTxHash(txHash: string): Promise<Receipt | null> {
    const row = qget<LedgerRow>(
      this.db,
      "SELECT * FROM sandbox_ledger WHERE tx_hash = ?",
      txHash
    );
    return row ? toReceipt(row) : null;
  }

  async lookupByIntentKey(intentKey: string): Promise<Receipt | null> {
    const row = qget<LedgerRow>(
      this.db,
      "SELECT * FROM sandbox_ledger WHERE intent_key = ?",
      intentKey
    );
    return row ? toReceipt(row) : null;
  }
}
