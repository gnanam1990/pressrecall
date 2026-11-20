/**
 * Signer adapter boundary. Real adapters (Altana session, Celo mainnet) are
 * gated; the default local path is the durable sandbox ledger. All chain
 * receipts flowing through here are labeled by `label`.
 */
export interface SendRequest {
  intentKey: string; // deterministic key: campaign + client key identity
  network: string;
  token: string;
  amountAtoms: number;
  fromAccount: string;
  toAccount: string;
  sessionId: string;
  grantId: string;
  fundedBy: string;
  /** Serialized session material bound to the grant, when the adapter
   *  needs it (Altana path: SerializedSession + scoped session key). */
  sessionData?: string;
}

export interface Receipt {
  txHash: string;
  intentKey: string;
  network: string;
  token: string;
  amountAtoms: number;
  fromAccount: string;
  toAccount: string;
  fundedBy: string;
  block: number;
  label: string;
}

/** Thrown when the adapter may have broadcast but the response was lost. */
export class AmbiguousError extends Error {
  constructor(
    message: string,
    public intentKey: string,
    /** Tracking handle the adapter learned before the response was lost
     *  (e.g. an EIP-5792 callsId), when one exists. */
    public handle?: string
  ) {
    super(message);
    this.name = "AmbiguousError";
  }
}

/** Thrown when policy/gates refuse the send — nothing was broadcast. */
export class PolicyDenialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyDenialError";
  }
}

export interface SignerAdapter {
  readonly label: string;
  /**
   * Where the adapter can attribute a spend to this deployment.
   * "OFFCHAIN" means attribution lives in PressRecall records
   * (intent key → callsId → txHash → fundedBy), not in the tx itself.
   */
  readonly attribution: "OFFCHAIN" | "ONCHAIN" | "NONE";
  send(req: SendRequest): Promise<Receipt>;
  lookupByTxHash(txHash: string): Promise<Receipt | null>;
  lookupByIntentKey(intentKey: string): Promise<Receipt | null>;
  /**
   * Adapters whose broadcast path returns a tracking handle before a tx hash
   * (EIP-5792 callsId) may implement handle-based recovery. Reconciliation
   * tries it after txHash and before intentKey.
   */
  lookupByHandle?(handle: string): Promise<Receipt | null>;
}
