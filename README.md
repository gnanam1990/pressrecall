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
| Real Celo mainnet spend | `NOT_RUN` — gated, requires explicit owner authorization |
| Altana Agent Wallets session | `NOT_RUN` — adapter stubbed; sandbox grant model used locally |
| Human pilot evidence | `NOT_RUN` — no impersonated evidence; sandbox flows are labeled `SANDBOX` |

## Requirements

- Node.js **22.5+** (uses built-in `node:sqlite` — no native dependencies,
  no runtime npm dependencies).

## Run

```sh
npm ci
npm start           # builds, then serves API + web UI on http://localhost:4173
```

Run the pack test suite:

```sh
npm test            # builds, then runs node --test over dist/tests
```

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
  injection for ambiguity tests). `AltanaAdapter` is gated and returns
  `NOT_CONFIGURED` without real credentials.
- `src/http/` — `node:http` router, scoped bearer-token auth, tenant
  isolation (cross-tenant = 404), JSON body bound (10 MB).
- `web/` — static accessible UI: producer dashboard, site compare, shop
  portal, field view (offline queue via `localStorage`), client release.

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

## Honest boundaries

- All payment flows run against the sandbox ledger unless real credentials
  are configured; sandbox artifacts are labeled `SANDBOX`.
- Team-funded transfers are excluded from independent-usage attribution.
- Public exports contain digests and redacted site labels only — no EXIF,
  no contact fields. Private audit view is buyer-scoped.
