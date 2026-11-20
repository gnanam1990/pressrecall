export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered, append-only migrations. Each runs inside a transaction via migrate().
 * Never edit a shipped migration; add a new one.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "core-domain",
    sql: `
CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('buyer','coordinator','printer','agent','operator')),
  display_name TEXT NOT NULL,
  printer_id TEXT,
  contact TEXT
);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  budget_cap_atoms INTEGER NOT NULL DEFAULT 0,
  budget_token TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','VERIFIED','CLOSED_WITH_EXCEPTIONS')),
  exception_note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  parent_id TEXT REFERENCES revisions(id),
  seq INTEGER NOT NULL,
  asset_digest TEXT NOT NULL,
  asset_path TEXT NOT NULL,
  change_class TEXT NOT NULL CHECK (change_class IN ('initial','body','redirect','both','none')),
  body TEXT NOT NULL,
  redirect_target TEXT,
  rights_note TEXT NOT NULL DEFAULT '',
  published_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, seq),
  UNIQUE (campaign_id, asset_digest)
);

CREATE TABLE placements (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  site_code TEXT NOT NULL,
  site_label TEXT NOT NULL,
  format TEXT NOT NULL,
  managed_redirect INTEGER NOT NULL DEFAULT 0,
  redirect_slug TEXT,
  observed_revision_id TEXT REFERENCES revisions(id),
  observed_revision_digest TEXT,
  observed_at TEXT,
  deadline TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, site_code)
);

CREATE TABLE plan_items (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  placement_id TEXT NOT NULL UNIQUE REFERENCES placements(id),
  target_revision_id TEXT NOT NULL REFERENCES revisions(id),
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('UNKNOWN','OBSERVED','REDIRECT_CHECK','REPRINT','VERIFIED','EXCEPTION')),
  decided_by TEXT,
  decided_at TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  campaign_id TEXT,
  actor_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_campaign ON events (campaign_id, seq);
`,
  },
  {
    version: 2,
    name: "scoped-auth-tokens",
    sql: `
ALTER TABLE actors ADD COLUMN secret TEXT;

CREATE TABLE auth_tokens (
  token TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_auth_tokens_actor ON auth_tokens (actor_id);
`,
  },
  {
    version: 3,
    name: "redirects-and-ink-fields",
    sql: `
CREATE TABLE redirects (
  slug TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  current_target TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE placements ADD COLUMN ink_fields TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 4,
    name: "redirect-managed-url",
    sql: `
ALTER TABLE redirects ADD COLUMN managed_url TEXT;
`,
  },
  {
    version: 5,
    name: "quotes-proofs-approvals",
    sql: `
CREATE TABLE quote_requests (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  plan_item_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  deadline TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  quote_request_id TEXT NOT NULL REFERENCES quote_requests(id),
  campaign_id TEXT NOT NULL,
  printer_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_digest TEXT NOT NULL,
  recipient TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price_atoms INTEGER NOT NULL,
  token TEXT NOT NULL,
  network TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'pay-printer',
  dimensions TEXT NOT NULL,
  deadline TEXT,
  expires_at TEXT NOT NULL,
  quote_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_quotes_campaign ON quotes (campaign_id);
CREATE INDEX idx_quotes_printer ON quotes (printer_id);

CREATE TABLE proofs (
  id TEXT PRIMARY KEY,
  quote_request_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  printer_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  proof_digest TEXT NOT NULL,
  asset_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_proofs_request ON proofs (quote_request_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  quote_request_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  proof_id TEXT NOT NULL,
  proof_hash TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  budget_atoms INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  superseded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_approvals_campaign ON approvals (campaign_id);
`,
  },
  {
    version: 6,
    name: "settlement",
    sql: `
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  max_amount_atoms INTEGER NOT NULL,
  token TEXT NOT NULL,
  network TEXT NOT NULL,
  allowed_payees TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  granted_by TEXT NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE order_intents (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  quote_request_id TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  client_key TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  shop_ref TEXT,
  state TEXT NOT NULL CHECK (state IN ('REQUESTED','RESERVED','CONFIRMED','DELIVERED','DISPUTED')),
  amount_atoms INTEGER NOT NULL,
  token TEXT NOT NULL,
  recipient TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, client_key)
);
CREATE UNIQUE INDEX idx_order_intents_shopref ON order_intents (shop_ref) WHERE shop_ref IS NOT NULL;
CREATE INDEX idx_order_intents_campaign ON order_intents (campaign_id);

CREATE TABLE spends (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES order_intents(id),
  campaign_id TEXT NOT NULL,
  network TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_atoms INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  session_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SUBMITTED','CONFIRMED','AMBIGUOUS','DEFINITIVELY_FAILED')),
  funded_by TEXT NOT NULL DEFAULT 'team',
  ledger_label TEXT NOT NULL DEFAULT 'SANDBOX',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE spend_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spend_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  raw TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE (spend_id, tx_hash)
);
CREATE UNIQUE INDEX idx_spend_receipts_txhash ON spend_receipts (tx_hash);

CREATE TABLE sandbox_ledger (
  tx_hash TEXT PRIMARY KEY,
  intent_key TEXT NOT NULL UNIQUE,
  network TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_atoms INTEGER NOT NULL,
  from_account TEXT NOT NULL,
  to_account TEXT NOT NULL,
  funded_by TEXT NOT NULL,
  block INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','FAILED')),
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 7,
    name: "settlement-handles",
    sql: `
ALTER TABLE grants ADD COLUMN session_data TEXT;
ALTER TABLE spends ADD COLUMN calls_id TEXT;
`,
  },
  {
    version: 8,
    name: "fulfillment-evidence",
    sql: `
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES order_intents(id),
  campaign_id TEXT NOT NULL,
  placement_id TEXT NOT NULL REFERENCES placements(id),
  qty INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  revision_digest TEXT,
  shipment_ref TEXT,
  client_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, client_key)
);
CREATE INDEX idx_deliveries_placement ON deliveries (placement_id);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  placement_id TEXT NOT NULL REFERENCES placements(id),
  client_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload_path TEXT NOT NULL,
  revision_digest_seen TEXT,
  captured_at TEXT,
  note TEXT,
  uploader_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, client_key)
);
CREATE INDEX idx_evidence_placement ON evidence (placement_id);
`,
  },
];
