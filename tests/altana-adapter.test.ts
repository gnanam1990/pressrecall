import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPrivateKeySigner,
  CELO_SEPOLIA,
  type Call,
  type SerializedSession,
} from "@altananetwork/sdk";
import {
  decodeFunctionData,
  encodeEventTopics,
  erc20Abi,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  AltanaAdapter,
  type AltanaDeps,
  type TxReceiptView,
} from "../src/chain/altana.js";
import { AmbiguousError, PolicyDenialError } from "../src/chain/adapter.js";

/**
 * Altana adapter contract tests — deterministic, offline. The real
 * deserializeSession → encodeFunctionData → execute → parseEventLogs path
 * is exercised; only the transport seams are faked. No secrets, no RPC,
 * no relay, no broadcast.
 */

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x2222222222222222222222222222222222222222" as Address;
const PAYEE = "0x3333333333333333333333333333333333333333" as Address;
const TXHASH = ("0x" + "ab".repeat(32)) as Hex;
const CALLSID = ("0x" + "cd".repeat(32)) as Hex;
const NOW = 1_800_000_000;

function sessionMaterial(opts?: { expiry?: number }) {
  const signer = createPrivateKeySigner();
  const serialized: SerializedSession = {
    walletAddress: WALLET,
    publicKey: signer.publicKey,
    permissions: {
      calls: [{ to: USDC }],
      spend: [{ limit: "1000000000", period: "day", token: USDC }],
    },
    expiry: opts?.expiry ?? NOW + 3600,
  };
  return {
    json: JSON.stringify({ serialized, sessionKey: signer._privateKey }),
    serialized,
  };
}

function transferLog(from: Address, to: Address, value: bigint, at: Address = USDC) {
  return {
    address: at,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from, to },
    }) as Hex[],
    data: pad(toHex(value), { size: 32 }) as Hex,
  };
}

function makeAdapter(over: Partial<AltanaDeps> = {}) {
  const calls: Call[] = [];
  const deps: AltanaDeps = {
    execute: async (_session, call) => {
      calls.push(call);
      return {
        callsId: CALLSID,
        transactionHash: TXHASH,
        status: "CONFIRMED",
      };
    },
    sessionKeyActive: async () => true,
    txReceipt: async (hash) =>
      hash === TXHASH
        ? ({
            status: "success",
            transactionHash: TXHASH,
            blockNumber: 1234n,
            logs: [transferLog(WALLET, PAYEE, 42000n)],
          } as TxReceiptView)
        : null,
    callsStatus: async () => null,
    now: () => NOW,
    ...over,
  };
  const adapter = new AltanaAdapter({
    network: CELO_SEPOLIA,
    tokenAddresses: { USD: USDC },
    deps,
  });
  return { adapter, calls };
}

function sendReq(sessionData?: string) {
  return {
    intentKey: "ik-test",
    network: "celo-sepolia",
    token: "USD",
    amountAtoms: 42000,
    fromAccount: "tenant:tnt",
    toAccount: PAYEE,
    sessionId: "sess_x",
    grantId: "grt_x",
    fundedBy: "team",
    sessionData,
  };
}

test("altana: confirmed send binds token contract, payee and exact amount", async () => {
  const { adapter, calls } = makeAdapter();
  const receipt = await adapter.send(sendReq(sessionMaterial().json));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to.toLowerCase(), USDC.toLowerCase());
  const decoded = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data! });
  assert.equal(decoded.functionName, "transfer");
  assert.equal((decoded.args[0] as string).toLowerCase(), PAYEE.toLowerCase());
  assert.equal(decoded.args[1], 42000n);

  assert.equal(receipt.txHash, TXHASH);
  assert.equal(receipt.token, "USD");
  assert.equal(receipt.toAccount, PAYEE);
  assert.equal(receipt.amountAtoms, 42000);
  assert.equal(receipt.block, 1234);
  assert.match(receipt.label, /^ALTANA:/);
  assert.equal(adapter.attribution, "OFFCHAIN"); // SDK has no ERC-8021 path
});

test("altana: missing session material, expired session and revoked key deny", async () => {
  const { adapter } = makeAdapter();
  // No session data at all.
  await assert.rejects(() => adapter.send(sendReq()), PolicyDenialError);
  // Expired session.
  const expired = sessionMaterial({ expiry: NOW - 1 });
  await assert.rejects(() => adapter.send(sendReq(expired.json)), PolicyDenialError);
  // On-chain key no longer registered (revoked): denies with valid material.
  const revoked = makeAdapter({ sessionKeyActive: async () => false });
  await assert.rejects(
    () => revoked.adapter.send(sendReq(sessionMaterial().json)),
    PolicyDenialError
  );
  // Unknown token contract.
  await assert.rejects(
    () =>
      adapter.send({ ...sendReq(sessionMaterial().json), token: "FOO" }),
    PolicyDenialError
  );
  // Recipient that is not a chain address.
  await assert.rejects(
    () =>
      adapter.send({
        ...sendReq(sessionMaterial().json),
        toAccount: "acct_printer_a",
      }),
    PolicyDenialError
  );
});

test("altana: PENDING result becomes ambiguous with callsId; handle reconciles", async () => {
  let callsStatusCalls = 0;
  const { adapter } = makeAdapter({
    execute: async () => ({ callsId: CALLSID, status: "PENDING" }),
    callsStatus: async (id) => {
      callsStatusCalls++;
      assert.equal(id, CALLSID);
      return { status: 200, receipts: [{ transactionHash: TXHASH }] };
    },
  });
  try {
    await adapter.send(sendReq(sessionMaterial().json));
    assert.fail("should have thrown AmbiguousError");
  } catch (err) {
    assert.ok(err instanceof AmbiguousError);
    assert.equal(err.handle, CALLSID);
  }
  const recovered = await adapter.lookupByHandle(CALLSID);
  assert.ok(recovered);
  assert.equal(recovered.txHash, TXHASH);
  assert.equal(callsStatusCalls, 1);
});

test("altana: receipt without matching Transfer log stays ambiguous", async () => {
  const { adapter } = makeAdapter({
    txReceipt: async () =>
      ({
        status: "success",
        transactionHash: TXHASH,
        blockNumber: 1n,
        logs: [transferLog(WALLET, PAYEE, 999n)], // wrong amount
      }) as TxReceiptView,
  });
  await assert.rejects(
    () => adapter.send(sendReq(sessionMaterial().json)),
    AmbiguousError
  );
});

test("altana: txReceipt path re-verifies a confirmed transfer", async () => {
  const { adapter } = makeAdapter();
  const rec = await adapter.lookupByTxHash(TXHASH);
  assert.ok(rec);
  assert.equal(rec.toAccount.toLowerCase(), PAYEE.toLowerCase());
  assert.equal(rec.amountAtoms, 42000);
  const missing = await adapter.lookupByTxHash("0x" + "00".repeat(32));
  assert.equal(missing, null);
});
