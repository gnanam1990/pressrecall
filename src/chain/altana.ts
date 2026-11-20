import {
  CELO,
  accountHasKey,
  createClient as createAltanaClient,
  deserializeSession,
  keyHashForSessionOrKey,
  signerFromPrivateKey,
  RELAY_URL,
  type Call,
  type ExecuteResult,
  type NetworkConfig,
  type SerializedSession,
  type Session,
  type Signer,
} from "@altananetwork/sdk";
import {
  createClient as createViemClient,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { getCallsStatus } from "viem/actions";
import {
  AmbiguousError,
  PolicyDenialError,
  type Receipt,
  type SendRequest,
  type SignerAdapter,
} from "./adapter.js";

/** On-chain receipt shape this adapter verifies against (viem-compatible). */
export interface TxReceiptView {
  status: string; // 'success' | 'reverted'
  transactionHash: Hex;
  blockNumber: bigint;
  logs: readonly {
    address: Address;
    topics: readonly Hex[];
    data: Hex;
  }[];
}

/** Status answer from the EIP-5792 relay (`wallet_getCallsStatus`). */
export interface CallsStatusView {
  status: number; // 100 pending, 200 confirmed, 400/500/600 failure
  receipts?: readonly { transactionHash?: Hex; blockNumber?: bigint | number | Hex }[];
}

/**
 * Transport/signing seams. Production wiring is supplied by `defaultDeps`
 * below; contract tests inject deterministic fakes. No fake is ever used
 * implicitly: an adapter without deps talks to the real relay and RPC.
 */
export interface AltanaDeps {
  /** client.execute session path — signs with the session key and relays. */
  execute(session: Session, call: Call): Promise<ExecuteResult>;
  /** On-chain read: is the session key still registered on the wallet? */
  sessionKeyActive(session: Session): Promise<boolean>;
  /** Public-RPC transaction receipt, or null while not yet indexed. */
  txReceipt(txHash: Hex): Promise<TxReceiptView | null>;
  /** EIP-5792 bundle status at the relay, or null when unknown there. */
  callsStatus(callsId: Hex): Promise<CallsStatusView | null>;
  now(): number;
}

/**
 * Session material handed to the agent by the human grant. `serialized`
 * is the SDK SerializedSession (wallet, publicKey, permissions, expiry);
 * `sessionKey` is the scoped session private key — a revocable,
 * time-bounded credential. This is the documented credential boundary:
 * the key can only do what the on-chain permissions allow and dies at
 * revoke or expiry. Never logged; never committed.
 */
export interface StoredSessionMaterial {
  serialized: SerializedSession;
  sessionKey: Hex;
}

export interface AltanaAdapterConfig {
  /** CELO (42220) mainnet default; CELO_SEPOLIA for a configured testnet run. */
  network?: NetworkConfig;
  /** Token symbol ("USDC") → ERC-20 contract address for that network. */
  tokenAddresses: Record<string, Address>;
  /**
   * Supplies session material for a grant session. Default reads the
   * grant's `session_data` JSON ({serialized, sessionKey}). Injected in
   * deployments that keep session keys in a KMS/keyfile.
   */
  resolveSession?: (
    sessionId: string,
    sessionDataJson: string | null
  ) => Promise<StoredSessionMaterial | null>;
  /** Dependency seam — contract tests inject fakes here. */
  deps?: Partial<AltanaDeps>;
}

function defaultDeps(network: NetworkConfig): AltanaDeps {
  const relayUrl = network.relayUrl ?? RELAY_URL;
  const altClient = createAltanaClient({ chains: [network] });
  const pub = createPublicClient({
    chain: network.chain,
    transport: http(network.publicRpcUrl),
  });
  const relayClient = createViemClient({ transport: http(relayUrl) });
  return {
    execute: (session, call) =>
      altClient.execute({ session, calls: [call], chainId: network.chainId }),
    sessionKeyActive: (session) =>
      accountHasKey(
        pub,
        session.walletAddress,
        keyHashForSessionOrKey(session)
      ),
    txReceipt: async (txHash) =>
      (await pub.getTransactionReceipt({ hash: txHash })) as TxReceiptView | null,
    callsStatus: async (callsId) => {
      const status = await getCallsStatus(relayClient, { id: callsId });
      return status as unknown as CallsStatusView;
    },
    now: () => Math.floor(Date.now() / 1000),
  };
}

async function defaultResolveSession(
  _sessionId: string,
  sessionDataJson: string | null
): Promise<StoredSessionMaterial | null> {
  if (!sessionDataJson) return null;
  try {
    const parsed = JSON.parse(sessionDataJson) as StoredSessionMaterial;
    if (!parsed.serialized || !parsed.sessionKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Decode the ERC-20 Transfer event inside a mined transaction and require it
 * to bind the token contract, payee and exact amount of the intended leg.
 */
function verifyTransfer(
  view: TxReceiptView,
  tokenAddress: Address,
  recipient: Address,
  amountAtoms: number
): { ok: boolean; reason?: string } {
  if (view.status !== "success") return { ok: false, reason: "tx reverted" };
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: view.logs as never,
  });
  const match = transfers.find(
    (t) =>
      t.address.toLowerCase() === tokenAddress.toLowerCase() &&
      t.args.to.toLowerCase() === recipient.toLowerCase() &&
      t.args.value === BigInt(amountAtoms)
  );
  if (!match) {
    return {
      ok: false,
      reason:
        "receipt contains no Transfer matching token/recipient/amount",
    };
  }
  return { ok: true };
}

/**
 * Real Altana Agent Wallets adapter (@altananetwork/sdk 1.1.0 + viem).
 *
 * - Executes the approved ERC-20 transfer through a human-granted,
 *   permission-scoped session key on the SDK's relay (EIP-7702 account).
 * - Re-verifies the grant AT USE TIME: local session expiry, then the
 *   on-chain session-key registration via accountHasKey — a revoked grant
 *   denies even with unchanged app credentials.
 * - Confirmed results are accepted only after the mined receipt's Transfer
 *   event is decoded and bound to token/payee/exact amount.
 * - PENDING/unanswered executions become AMBIGUOUS with the callsId handle;
 *   reconcile recovers via relay status then public-RPC receipt.
 *
 * HONEST LIMITATION (documented, not hidden): SDK 1.1.0 offers no ERC-8021
 * builder-code/calldata-suffix support — Call is exactly {to, value, data}
 * and the relay builds the intent. On-chain attribution to this app is
 * therefore NOT possible via the SDK; attribution is OFFCHAIN in
 * PressRecall records (intentKey → callsId → txHash → grant → fundedBy).
 * ERC-8004 wallet identity is an admin-path property of the wallet, not
 * of session executes.
 */
export class AltanaAdapter implements SignerAdapter {
  readonly attribution = "OFFCHAIN" as const;
  private readonly deps: AltanaDeps;
  private readonly resolveSession: NonNullable<
    AltanaAdapterConfig["resolveSession"]
  >;

  constructor(private cfg: AltanaAdapterConfig) {
    const network = cfg.network ?? CELO;
    cfg.network = network;
    this.deps = { ...defaultDeps(network), ...cfg.deps };
    this.resolveSession = cfg.resolveSession ?? defaultResolveSession;
  }

  get label(): string {
    const n = this.cfg.network ?? CELO;
    return `ALTANA:${n.chain.name}:${n.chainId}`;
  }

  async send(req: SendRequest): Promise<Receipt> {
    const material = await this.resolveSession(req.sessionId, req.sessionData ?? null);
    if (!material) {
      throw new PolicyDenialError(
        "no session material for this grant — real session keys are required (NOT_RUN without them)"
      );
    }
    let session: Session;
    try {
      session = deserializeSession(
        material.serialized,
        signerFromPrivateKey(material.sessionKey)
      );
    } catch (err) {
      throw new PolicyDenialError(
        `session material is malformed: ${(err as Error).message}`
      );
    }
    if (session.expiry <= this.deps.now()) {
      throw new PolicyDenialError("session expired");
    }
    const tokenAddress = this.cfg.tokenAddresses[req.token];
    if (!tokenAddress) {
      throw new PolicyDenialError(
        `token '${req.token}' has no configured contract on ${this.label}`
      );
    }
    if (!isAddress(req.toAccount)) {
      throw new PolicyDenialError(
        `recipient '${req.toAccount}' is not a chain address`
      );
    }
    // Use-time, on-chain grant check. A transport failure here is ambiguous,
    // not clean: we cannot confirm the grant is alive.
    let active: boolean;
    try {
      active = await this.deps.sessionKeyActive(session);
    } catch (err) {
      throw new AmbiguousError(
        `could not verify session key on-chain: ${(err as Error).message}`,
        req.intentKey
      );
    }
    if (!active) {
      throw new PolicyDenialError(
        "session key is not registered on-chain (revoked or never granted)"
      );
    }

    const call: Call = {
      to: tokenAddress,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [req.toAccount as Address, BigInt(req.amountAtoms)],
      }),
    };

    let result: ExecuteResult;
    try {
      result = await this.deps.execute(session, call);
    } catch (err) {
      // The relay may have accepted the intent before the connection dropped.
      throw new AmbiguousError(
        `execute did not return a confirmed result: ${(err as Error).message}`,
        req.intentKey
      );
    }

    if (result.status === "FAILED") {
      throw new Error("execute reported FAILED on-chain");
    }
    if (result.status !== "CONFIRMED" || !result.transactionHash) {
      throw new AmbiguousError(
        `execute returned ${result.status} without a transaction hash`,
        req.intentKey,
        result.callsId
      );
    }

    const view = await this.deps.txReceipt(result.transactionHash);
    if (!view) {
      throw new AmbiguousError(
        "confirmed tx not yet indexed by public RPC",
        req.intentKey,
        result.transactionHash
      );
    }
    const verified = verifyTransfer(
      view,
      tokenAddress,
      req.toAccount as Address,
      req.amountAtoms
    );
    if (!verified.ok) {
      // Contents do not bind the intended leg — freeze for human escalation.
      throw new AmbiguousError(
        `receipt did not verify (${verified.reason})`,
        req.intentKey,
        result.transactionHash
      );
    }
    return {
      txHash: result.transactionHash,
      intentKey: req.intentKey,
      network: req.network,
      token: req.token,
      amountAtoms: req.amountAtoms,
      fromAccount: session.walletAddress,
      toAccount: req.toAccount,
      fundedBy: req.fundedBy,
      block: Number(view.blockNumber),
      label: this.label,
    };
  }

  async lookupByTxHash(txHash: string): Promise<Receipt | null> {
    const view = await this.deps.txReceipt(txHash as Hex);
    if (!view || view.status !== "success") return null;
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: view.logs as never,
    });
    const t = transfers.find((x) =>
      Object.values(this.cfg.tokenAddresses).some(
        (a) => a.toLowerCase() === x.address.toLowerCase()
      )
    );
    if (!t) return null;
    const token =
      Object.entries(this.cfg.tokenAddresses).find(
        ([, a]) => a.toLowerCase() === t.address.toLowerCase()
      )?.[0] ?? t.address;
    return {
      txHash,
      intentKey: "",
      network: this.label,
      token,
      amountAtoms: Number(t.args.value),
      fromAccount: t.args.from,
      toAccount: t.args.to,
      fundedBy: "unknown",
      block: Number(view.blockNumber),
      label: this.label,
    };
  }

  /**
   * Recover a broadcast whose response was lost: resolve the callsId at the
   * relay to a transaction hash, then verify the on-chain receipt.
   */
  async lookupByHandle(handle: string): Promise<Receipt | null> {
    // The handle may be a callsId (pre-hash drop) or a tx hash itself
    // (post-hash drop). Try the relay status first, then the public RPC.
    try {
      const status = await this.deps.callsStatus(handle as Hex);
      if (status && status.status === 200) {
        const txHash = status.receipts?.find((r) => r.transactionHash)
          ?.transactionHash;
        if (txHash) return this.lookupByTxHash(txHash);
      }
    } catch {
      // relay unreachable — fall through to the hash path
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(handle)) {
      return this.lookupByTxHash(handle);
    }
    return null;
  }

  /** Our intent key has no on-chain index — reconciliation uses txHash/handle. */
  async lookupByIntentKey(_intentKey: string): Promise<Receipt | null> {
    return null;
  }
}
