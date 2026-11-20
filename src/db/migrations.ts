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
];
