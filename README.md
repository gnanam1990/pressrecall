# PressRecall

Revision-aware print recall, scoped purchasing and site acceptance.

A campaign producer changed an event date after printing. PressRecall tracks
what is installed on each wall, decides whether a managed redirect or revised
ink is needed, collects shop quotes against bound print proofs, executes a
single scoped payment through a human-granted session, and exports a client
acceptance report.

## Status

| Capability | State |
|---|---|
| Local durable API + sandbox ledger | Implemented (see module PRs) |
| Altana Agent Wallets adapter | Implemented, **disabled by default** — real `@altananetwork/sdk` path; all sends deny without configured session material |
| Real Celo mainnet spend | `NOT_RUN` — requires `PRESSRECALL_CHAIN_ADAPTER=altana`, real session material, and explicit owner authorization |
| Human pilot evidence | `NOT_RUN` — no impersonated evidence; sandbox flows are labeled `SANDBOX` |

## Requirements

- Node.js **22.5+** (uses built-in `node:sqlite` — no native dependencies).
- Runtime deps: `@altananetwork/sdk@1.1.0` + `viem@2.57.18` — the real
  settlement provider path (opt-in; see *Settlement adapters*). `1.1.0` is
  the first line exporting `CELO`; `viem` is pinned to a version published
  ≥7 days ago satisfying the SDK's `^2.21.0` range. The API, storage and
  all tests run without them being exercised (sandbox default).

## Run

```sh
npm ci
npm start           # builds, then serves API + web UI on http://127.0.0.1:4173
```

The server binds loopback (`127.0.0.1`) by default — set `PRESSRECALL_BIND`
to expose it deliberately. On first launch against a fresh database it
seeds the documented local demo actors so the browser sign-in works out
of the box (sandbox mode only — see *Live mode* below).

Run the pack test suite:

```sh
npm test            # builds, then runs node --test over dist/tests
```

## Browser demo

Open `http://127.0.0.1:4173` and sign in — the demo actor picker prefills
local credentials. Local demo actors (sandbox mode only):

| Actor | Role | Secret |
|---|---|---|
| `act_buyer` | buyer | `sec_buyer` |
| `act_agent` | agent | `sec_agent` |
| `act_coord` | coordinator | `sec_coord` |
| `act_ops` | operator | `sec_ops` |
| `act_printer_a` | printer | `sec_printer_a` |
| `act_printer_b` | printer | `sec_printer_b` |

One browser can drive every role via **Switch actor** in the top bar. The
numbered cards on a campaign workspace carry the full lifecycle:

1. **Artwork** — publish the original and the revised asset (file or text;
   a `redirectTarget` marks web-correctable content).
2. **Sites** — add a physical site (ink fields) and/or a managed-redirect
   site (slug). The operator registers the deployed redirect; a field
   agent's *Scan live redirect* observes the real HTTP resolution under the
   scoped allowlist — `GET /r/:slug` on this server is the demo operator
   redirector.
3. **Quotes** — send an RFQ, switch to a printer to submit a quote and
   upload a bound proof, switch back to approve.
4. **Payment** — grant a scoped session, create the intent, the shop
   reserves, then execute. Labeled `SANDBOX` — simulated, not real money.
5. **Delivery & evidence** — the shop accepts and delivers; a field upload
   queues offline in `localStorage` and retries with the same client key
   across reloads.
6. **Release** — preview the report, release, and share the `/export.html`
   client link — a redacted snapshot that opens with no sign-in.

Fresh-context browser acceptance (Playwright):

```sh
npx playwright install chromium   # one-time browser download
npm run test:browser              # builds, launches the app, runs tests/browser
```

## Live mode

`PRESSRECALL_CHAIN_ADAPTER=altana` opts into the real provider path. The
startup guard refuses to boot when it finds either:

- `PRESSRECALL_DEMO_AUTH=1` — the isolated-demo actor-header path, or
- documented demo credentials still present in the `actors` table.

Demo actors are never seeded in live mode. Provision real actors with
unique secrets, then sign in through `POST /api/auth/token`:

```sh
npm run build
node scripts/provision-actor.mjs act_acme tnt_acme buyer 'long-random-secret'
```

Live spend additionally needs session material per grant (`sessionData`)
and `PRESSRECALL_ALTANA_TOKENS`; without them every send denies as
`NOT_CONFIGURED`.

## Architecture

`src/` is layered, dependency-injected at the entry point:

- `src/db/` — `node:sqlite` connection (WAL), append-only migrations. Durable
  local file; Postgres-portable SQL. `BEGIN IMMEDIATE` transactions give
  serializable writes for the transactional budget cap.
- `src/domain/` — canonical JSON hashing (stable key order, UTF-8), ids,
  typed API errors.
- `src/services/` — one module per domain boundary: `campaigns` (revisions,
  placements, observations), `planner` (redirect vs. reprint decisions),
  `quotes` (canonical quote hash, proofs, approvals), `settlement` (grants,
  order intents, budget reservation, outbox, receipts), `fulfillment`
  (evidence, shop jobs), `release` (reports, redaction, exceptions),
  `events` (monotonic structured transition log).
- `src/chain/` — `SignerAdapter` interface; `SandboxChainAdapter` is the
  default local ledger (labeled `SANDBOX`, deterministic tx hashes, fault
  injection for ambiguity tests). `AltanaAdapter` is the real provider
  implementation (see below).
- `src/http/` — `node:http` router, scoped bearer-token auth, tenant
  isolation (cross-tenant = 404), JSON body bound (10 MB).
- `web/` — static accessible UI: sign-in + actor switcher, campaign
  workspace (numbered stage cards), site compare, print-shop board,
  offline field queue (`localStorage`, client-key idempotent),
  redacted client export. `tests/browser/` holds the fresh-context
  Playwright acceptance (T-014).

Roles: `buyer` (producer) approves proofs/quotes and grants/revokes wallet
authority; `coordinator` supplies site evidence; `printer` sees only its own
quotes/orders; `agent` evaluates plans and executes within grant scope;
`operator` controls managed redirects.

## Auth

Tenant routes require `Authorization: Bearer prt_…` scoped tokens. Issue one
with the actor's local secret:

```sh
curl -X POST localhost:4173/api/auth/token \
  -H 'content-type: application/json' \
  -d '{"actorId":"act_buyer","secret":"sec_buyer"}'
```

Scopes are role-capped (`src/http/auth.ts` → `ROLE_SCOPES`); requesting a
scope outside the role is refused at issuance. `POST /api/auth/revoke`
revokes a token immediately; expired tokens are rejected at use time.

A bare `x-actor-id` header is **rejected** everywhere by default. It resolves
only when the server is started with `PRESSRECALL_DEMO_AUTH=1`, an explicit
isolated-demo escape hatch — do not use it for shared or pilot deployments.

## Redirect verification

A redirect-only placement is VERIFIED only after the server observes the
deployed managed URL actually resolving to the approved destination — the
registry row alone records intent, not proof. The destination fetcher is
tightly scoped: http/https only, single request, `redirect: manual`, and the
hostname must be in `PRESSRECALL_REDIRECT_ALLOWED_HOSTS` (default:
`127.0.0.1,localhost`). `GET /r/:slug` is the demo operator redirector used
locally. Field scans can also be recorded manually via `manualLocation` —
they are retained explicitly as UNVERIFIED and cannot close the item.

## Settlement adapters

Default is the **sandbox** — a durable local ledger (`sandbox_ledger`),
deterministic tx hashes, write-once rows keyed by the intent's deterministic
identity. It executes the complete intent → grant → reserve → execute →
receipt → reconcile lifecycle and supports fault injection (`dropResponse`)
for ambiguity tests. Everything it emits is labeled `SANDBOX`.

`AltanaAdapter` (`src/chain/altana.ts`) is the real provider path:

- Executes the approved ERC-20 `transfer` through a human-granted,
  permission-scoped **session key** via `client.execute({session, calls})`
  on the SDK relay. Call data is built with viem `encodeFunctionData`
  bound to the token contract, payee and exact atomic amount.
- Re-verifies the grant **at use time**: session expiry, then the on-chain
  session-key registration (`accountHasKey` on the public RPC). A revoked
  grant denies even with unchanged app credentials.
- A confirmed result is accepted only after the mined receipt's ERC-20
  `Transfer` event is decoded and bound to token/payee/exact amount.
- `PENDING` or unanswered executions become `AMBIGUOUS` carrying the
  EIP-5792 `callsId`; reconciliation recovers via relay `getCallsStatus`
  then the public-RPC receipt, never allocating a second leg.

Opt-in only (never default): `PRESSRECALL_CHAIN_ADAPTER=altana` plus
`PRESSRECALL_ALTANA_TOKENS='{"USD":"0x…contract…"}'`; each grant carries
`sessionData` (`{serialized, sessionKey}` — a scoped, revocable credential,
never logged). Without all three, every send denies as `NOT_CONFIGURED` —
nothing can broadcast. Real mainnet spend remains `NOT_RUN` without
explicit owner authorization.

**Documented limitation:** `@altananetwork/sdk@1.1.0` has no ERC-8021
builder-code/calldata-suffix support (`Call` is `{to, value, data}` and the
relay builds the intent). On-chain attribution to this app is therefore not
possible through the SDK; attribution is OFFCHAIN in PressRecall records
(intentKey → callsId → txHash → grant → fundedBy) — `adapter.attribution`
reports `OFFCHAIN`. ERC-8004 wallet identity is an admin-path wallet
property, not part of session executes.

## Honest boundaries

- All payment flows run against the sandbox ledger unless real credentials
  are configured; sandbox artifacts are labeled `SANDBOX`.
- Team-funded transfers are excluded from independent-usage attribution.
- Public exports contain digests and redacted site labels only — no EXIF,
  no contact fields. Private audit view is buyer-scoped.
