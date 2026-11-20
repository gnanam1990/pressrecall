import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Route } from "./server.js";
import { mintToken, revokeToken } from "./auth.js";
import {
  createCampaign,
  createPlacement,
  getCampaign,
  getPlacement,
  getRevision,
  placementView,
  publishRevision,
  recordObservation,
  revisionView,
  type PlacementRow,
  type RevisionRow,
} from "../services/campaigns.js";
import {
  evaluateCampaign,
  recordScan,
  upsertRedirect,
} from "../services/planner.js";
import { createResolver, type RedirectPolicy } from "../services/fetcher.js";
import type { SignerAdapter } from "../chain/adapter.js";
import {
  createGrant,
  createOrderIntent,
  executeIntent,
  grantView,
  intentView,
  reconcileSpend,
  reserveIntent,
  revokeGrant,
  spendView,
  type GrantRow,
  type IntentRow,
  type SpendRow,
} from "../services/settlement.js";
import {
  approvalEligible,
  approvalView,
  createApproval,
  createQuoteRequest,
  getQuote,
  quoteView,
  submitQuote,
  uploadProof,
  type QuoteRequestRow,
  type QuoteRow,
  type ApprovalRow,
} from "../services/quotes.js";

export interface AppContext {
  objectDir: string;
  chain: SignerAdapter;
  redirectPolicy?: RedirectPolicy;
}

export function buildRoutes(app: AppContext): Route[] {
  const resolve = createResolver(app.redirectPolicy ?? { allowedHosts: [] });
  return [
    {
      method: "POST",
      pattern: "/api/auth/token",
      public: true,
      handler: ({ db, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const { token, actor } = mintToken(db, {
          actorId: String(b.actorId ?? ""),
          secret: String(b.secret ?? ""),
          scopes: Array.isArray(b.scopes)
            ? (b.scopes as unknown[]).map(String)
            : undefined,
          expiresAt: b.expiresAt ? String(b.expiresAt) : undefined,
        });
        return {
          status: 201,
          body: {
            token,
            actor: {
              id: actor.id,
              role: actor.role,
              tenantId: actor.tenantId,
              scopes: actor.scopes,
            },
          },
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/auth/revoke",
      handler: ({ db, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        revokeToken(db, String(b.token ?? ""));
        return { body: { revoked: true } };
      },
    },
    {
      method: "GET",
      pattern: "/api/auth/me",
      handler: ({ actor }) => ({
        body: {
          id: actor!.id,
          role: actor!.role,
          tenantId: actor!.tenantId,
          displayName: actor!.displayName,
          scopes: actor!.scopes,
        },
      }),
    },
    {
      method: "POST",
      pattern: "/api/campaigns",
      roles: ["buyer", "agent"],
      scope: "campaigns:write",
      handler: ({ db, actor, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const campaign = createCampaign(db, actor!, {
          name: String(b.name ?? ""),
          budgetCapAtoms: numOr(b.budgetCapAtoms),
          budgetToken: b.budgetToken ? String(b.budgetToken) : undefined,
        });
        return { status: 201, body: campaignView(campaign) };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns",
      roles: ["buyer", "coordinator", "agent", "operator"],
      scope: "campaigns:read",
      handler: ({ db, actor }) => {
        const rows = db
          .prepare("SELECT * FROM campaigns WHERE tenant_id = ? ORDER BY created_at")
          .all(actor!.tenantId) as unknown as { id: string }[];
        return {
          body: {
            campaigns: rows.map((r) => campaignView(getCampaign(db, actor!, r.id))),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id",
      roles: ["buyer", "coordinator", "agent", "operator"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => ({
        body: campaignView(getCampaign(db, actor!, params.id!)),
      }),
    },
    {
      method: "POST",
      pattern: "/api/campaigns/:id/revisions",
      roles: ["buyer"],
      scope: "revisions:write",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const rev = publishRevision(db, actor!, app.objectDir, params.id!, {
          assetText: b.assetText !== undefined ? String(b.assetText) : undefined,
          assetBase64:
            b.assetBase64 !== undefined ? String(b.assetBase64) : undefined,
          changeClass:
            b.changeClass !== undefined ? String(b.changeClass) : undefined,
          body: (b.body as Record<string, unknown>) ?? {},
          redirectTarget:
            b.redirectTarget !== undefined && b.redirectTarget !== null
              ? String(b.redirectTarget)
              : null,
          parentId: b.parentId ? String(b.parentId) : undefined,
          rightsNote: b.rightsNote ? String(b.rightsNote) : undefined,
        });
        return { status: 201, body: revisionView(rev) };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/revisions",
      roles: ["buyer", "coordinator", "agent", "operator"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rows = db
          .prepare(
            "SELECT * FROM revisions WHERE campaign_id = ? ORDER BY seq"
          )
          .all(params.id!) as unknown as RevisionRow[];
        return { body: { revisions: rows.map(revisionView) } };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/revisions/:rid",
      roles: ["buyer", "coordinator", "agent", "operator"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        return { body: revisionView(getRevision(db, params.id!, params.rid!)) };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/revisions/:rid/asset",
      roles: ["buyer", "coordinator", "agent", "operator"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rev = getRevision(db, params.id!, params.rid!);
        const bytes = readFileSync(join(app.objectDir, rev.asset_path));
        return {
          body: {
            revisionId: rev.id,
            assetDigest: rev.asset_digest,
            assetBase64: bytes.toString("base64"),
          },
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/campaigns/:id/placements",
      roles: ["buyer", "agent"],
      scope: "placements:write",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const { placement } = createPlacement(db, actor!, params.id!, {
          siteCode: String(b.siteCode ?? ""),
          siteLabel: String(b.siteLabel ?? ""),
          format: String(b.format ?? ""),
          managedRedirect: !!b.managedRedirect,
          redirectSlug: b.redirectSlug ? String(b.redirectSlug) : undefined,
          observedRevisionId: b.observedRevisionId
            ? String(b.observedRevisionId)
            : undefined,
          observedDigest: b.observedDigest ? String(b.observedDigest) : undefined,
          observedAt: b.observedAt ? String(b.observedAt) : undefined,
          deadline: b.deadline ? String(b.deadline) : undefined,
          inkFields: Array.isArray(b.inkFields)
            ? (b.inkFields as unknown[]).map(String)
            : undefined,
        });
        return { status: 201, body: placementView(db, placement) };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/placements",
      roles: ["buyer", "coordinator", "agent", "operator"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rows = db
          .prepare(
            "SELECT * FROM placements WHERE campaign_id = ? ORDER BY site_code"
          )
          .all(params.id!) as unknown as PlacementRow[];
        return {
          body: { placements: rows.map((p) => placementView(db, p)) },
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/placements/:pid",
      roles: ["buyer", "coordinator", "agent", "operator"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const p = getPlacement(db, params.id!, params.pid!);
        return { body: placementView(db, p) };
      },
    },
    {
      method: "POST",
      pattern: "/api/campaigns/:id/placements/:pid/observations",
      roles: ["buyer", "coordinator", "agent"],
      scope: "observations:write",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        recordObservation(db, actor!, params.id!, params.pid!, {
          observedRevisionId: b.observedRevisionId
            ? String(b.observedRevisionId)
            : undefined,
          observedDigest: b.observedDigest ? String(b.observedDigest) : undefined,
          observedAt: b.observedAt ? String(b.observedAt) : undefined,
        });
        const p = getPlacement(db, params.id!, params.pid!);
        return { body: placementView(db, p) };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/verification-queue",
      roles: ["buyer", "coordinator", "agent"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rows = db
          .prepare(
            `SELECT p.* FROM placements p
             JOIN plan_items pi ON pi.placement_id = p.id
             WHERE p.campaign_id = ? AND pi.state = 'UNKNOWN'
             ORDER BY p.site_code`
          )
          .all(params.id!) as unknown as PlacementRow[];
        return {
          body: {
            queue: rows.map((p) => placementView(db, p)),
          },
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/campaigns/:id/plans/evaluate",
      roles: ["agent"],
      scope: "plans:evaluate",
      handler: async ({ db, actor, params }) => ({
        body: { results: await evaluateCampaign(db, actor!, params.id!, resolve) },
      }),
    },
    {
      method: "POST",
      pattern: "/api/campaigns/:id/plan-items/:piid/scan",
      roles: ["agent", "coordinator"],
      scope: "observations:write",
      handler: async ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const item = await recordScan(db, actor!, params.id!, params.piid!, {
          manualLocation:
            b.manualLocation !== undefined ? String(b.manualLocation) : undefined,
          note: b.note !== undefined ? String(b.note) : undefined,
        }, resolve);
        return {
          body: {
            id: item.id,
            state: item.state,
            reason: item.reason,
            decidedBy: item.decided_by,
            decidedAt: item.decided_at,
            evidence: item.evidence ? JSON.parse(item.evidence) : null,
          },
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/redirects",
      roles: ["operator"],
      scope: "redirects:write",
      handler: ({ db, actor, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const row = upsertRedirect(db, actor!, {
          slug: String(b.slug ?? ""),
          target: String(b.target ?? ""),
          managedUrl: b.managedUrl !== undefined ? String(b.managedUrl) : undefined,
        });
        return {
          status: 201,
          body: {
            slug: row.slug,
            currentTarget: row.current_target,
            managedUrl: row.managed_url,
            updatedBy: row.updated_by,
            updatedAt: row.updated_at,
          },
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/campaigns/:id/quote-requests",
      roles: ["buyer", "agent"],
      scope: "quotes:write",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const row = createQuoteRequest(db, actor!, params.id!, {
          planItemId: String(b.planItemId ?? ""),
          revisionId: String(b.revisionId ?? ""),
          dimensions: String(b.dimensions ?? ""),
          deadline: b.deadline ? String(b.deadline) : undefined,
          qty: typeof b.qty === "number" ? b.qty : undefined,
        });
        return { status: 201, body: quoteRequestView(row) };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/quote-requests",
      roles: ["buyer", "agent", "coordinator"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rows = db
          .prepare(
            "SELECT * FROM quote_requests WHERE campaign_id = ? ORDER BY created_at"
          )
          .all(params.id!) as unknown as QuoteRequestRow[];
        return { body: { quoteRequests: rows.map(quoteRequestView) } };
      },
    },
    {
      method: "GET",
      pattern: "/api/printer/quote-requests",
      roles: ["printer"],
      scope: "jobs:read",
      handler: ({ db }) => {
        const rows = db
          .prepare(
            "SELECT * FROM quote_requests WHERE status = 'OPEN' ORDER BY created_at"
          )
          .all() as unknown as QuoteRequestRow[];
        return { body: { quoteRequests: rows.map(quoteRequestView) } };
      },
    },
    {
      method: "POST",
      pattern: "/api/printer/quote-requests/:qrid/quotes",
      roles: ["printer"],
      scope: "quotes:write",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const q = submitQuote(db, actor!, params.qrid!, {
          qty: Number(b.qty ?? 0),
          priceAtoms: Number(b.priceAtoms ?? -1),
          token: String(b.token ?? ""),
          network: b.network ? String(b.network) : undefined,
          recipient: String(b.recipient ?? ""),
          expiresAt: String(b.expiresAt ?? ""),
          direction: b.direction ? String(b.direction) : undefined,
        });
        return { status: 201, body: quoteView(q) };
      },
    },
    {
      method: "POST",
      pattern: "/api/printer/quote-requests/:qrid/proofs",
      roles: ["printer"],
      scope: "proofs:write",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const p = uploadProof(db, actor!, app.objectDir, params.qrid!, {
          assetText: b.assetText !== undefined ? String(b.assetText) : undefined,
          assetBase64:
            b.assetBase64 !== undefined ? String(b.assetBase64) : undefined,
        });
        return {
          status: 201,
          body: {
            id: p.id,
            quoteRequestId: p.quote_request_id,
            printerId: p.printer_id,
            revisionId: p.revision_id,
            proofDigest: p.proof_digest,
            createdAt: p.created_at,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/printer/quotes",
      roles: ["printer"],
      scope: "quotes:read",
      handler: ({ db, actor }) => {
        const rows = db
          .prepare(
            "SELECT * FROM quotes WHERE printer_id = ? ORDER BY created_at"
          )
          .all(actor!.printerId) as unknown as QuoteRow[];
        return { body: { quotes: rows.map(quoteView) } };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/quotes",
      roles: ["buyer", "agent"],
      scope: "quotes:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rows = db
          .prepare(
            "SELECT * FROM quotes WHERE campaign_id = ? ORDER BY created_at"
          )
          .all(params.id!) as unknown as QuoteRow[];
        return { body: { quotes: rows.map(quoteView) } };
      },
    },
    {
      method: "POST",
      pattern: "/api/campaigns/:id/approvals",
      roles: ["buyer"],
      scope: "approvals:write",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const a = createApproval(db, actor!, params.id!, {
          quoteId: String(b.quoteId ?? ""),
          proofId: String(b.proofId ?? ""),
        });
        const q = getQuote(db, params.id!, a.quote_id);
        return { status: 201, body: approvalView(a, q) };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/approvals",
      roles: ["buyer", "agent"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rows = db
          .prepare(
            "SELECT * FROM approvals WHERE campaign_id = ? ORDER BY created_at"
          )
          .all(params.id!) as unknown as ApprovalRow[];
        return {
          body: {
            approvals: rows.map((a) => ({
              ...approvalView(a, getQuote(db, params.id!, a.quote_id)),
              eligibility: approvalEligible(db, a),
            })),
          },
        };
      },
    },
    {
      // Demo operator redirector: serves the managed destination as a real
      // HTTP 302 — the honest local stand-in for the operator's deployed
      // redirect service that an installed QR actually resolves.
      method: "GET",
      pattern: "/r/:slug",
      public: true,
      handler: ({ db, params }) => {
        const row = db
          .prepare("SELECT current_target FROM redirects WHERE slug = ?")
          .get(params.slug!) as { current_target: string } | undefined;
        if (!row) {
          return { status: 404, body: { error: { code: "not_found", message: "unknown redirect slug" } } };
        }
        return { redirect: row.current_target };
      },
    },
    {
      method: "GET",
      pattern: "/api/redirects/:slug",
      scope: "redirects:read",
      handler: ({ db, actor, params }) => {
        const row = db
          .prepare("SELECT * FROM redirects WHERE slug = ? AND tenant_id = ?")
          .get(params.slug!, actor!.tenantId) as
          | {
              slug: string;
              current_target: string;
              managed_url: string | null;
              updated_by: string;
              updated_at: string;
            }
          | undefined;
        if (!row) {
          return { status: 404, body: { error: { code: "not_found", message: "redirect not found" } } };
        }
        return {
          body: {
            slug: row.slug,
            currentTarget: row.current_target,
            managedUrl: row.managed_url,
            updatedBy: row.updated_by,
            updatedAt: row.updated_at,
          },
        };
      },
    },
    // ---- M04: settlement ----
    {
      method: "POST",
      pattern: "/api/campaigns/:id/grants",
      roles: ["buyer"],
      scope: "grants:write",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const g = createGrant(db, actor!, params.id!, {
          sessionId: String(b.sessionId ?? ""),
          maxAmountAtoms: Number(b.maxAmountAtoms ?? 0),
          token: String(b.token ?? ""),
          network: String(b.network ?? ""),
          allowedPayees: Array.isArray(b.allowedPayees)
            ? (b.allowedPayees as unknown[]).map(String)
            : [],
          sessionData:
            b.sessionData !== undefined ? String(b.sessionData) : undefined,
        });
        return { status: 201, body: grantView(g) };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/grants",
      roles: ["buyer", "agent"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rows = db
          .prepare(
            "SELECT * FROM grants WHERE campaign_id = ? ORDER BY created_at"
          )
          .all(params.id!) as unknown as GrantRow[];
        return { body: { grants: rows.map(grantView) } };
      },
    },
    {
      method: "POST",
      pattern: "/api/grants/:id/revoke",
      roles: ["buyer"],
      scope: "grants:write",
      handler: ({ db, actor, params }) => ({
        body: grantView(revokeGrant(db, actor!, params.id!)),
      }),
    },
    {
      method: "POST",
      pattern: "/api/campaigns/:id/order-intents",
      roles: ["buyer", "agent"],
      scope: "intents:write",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const { intent, created } = createOrderIntent(db, actor!, params.id!, {
          approvalId: String(b.approvalId ?? ""),
          clientKey: String(b.clientKey ?? ""),
        });
        return { status: created ? 201 : 200, body: intentView(intent) };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/order-intents",
      roles: ["buyer", "agent"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rows = db
          .prepare(
            "SELECT * FROM order_intents WHERE campaign_id = ? ORDER BY created_at"
          )
          .all(params.id!) as unknown as IntentRow[];
        return { body: { intents: rows.map(intentView) } };
      },
    },
    {
      method: "GET",
      pattern: "/api/printer/jobs",
      roles: ["printer"],
      scope: "jobs:read",
      handler: ({ db, actor }) => {
        const rows = db
          .prepare(
            `SELECT i.* FROM order_intents i
              JOIN approvals a ON a.id = i.approval_id
              JOIN quotes q ON q.id = a.quote_id
             WHERE q.printer_id = ? ORDER BY i.created_at`
          )
          .all(actor!.printerId) as unknown as IntentRow[];
        return { body: { jobs: rows.map(intentView) } };
      },
    },
    {
      method: "POST",
      pattern: "/api/order-intents/:id/reserve",
      roles: ["printer"],
      scope: "intents:reserve",
      handler: ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const i = reserveIntent(db, actor!, params.id!, {
          shopRef: String(b.shopRef ?? ""),
        });
        return { body: intentView(i) };
      },
    },
    {
      method: "POST",
      pattern: "/api/order-intents/:id/execute",
      roles: ["buyer", "agent"],
      scope: "intents:write",
      handler: async ({ db, actor, params, body }) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const s = await executeIntent(db, actor!, params.id!, app.chain, {
          grantId: b.grantId ? String(b.grantId) : undefined,
          fundedBy: b.fundedBy ? String(b.fundedBy) : undefined,
        });
        return { body: spendView(s) };
      },
    },
    {
      method: "POST",
      pattern: "/api/spends/:id/reconcile",
      roles: ["buyer", "agent"],
      scope: "intents:write",
      handler: async ({ db, actor, params }) => {
        const r = await reconcileSpend(db, actor!, params.id!, app.chain);
        return { body: r };
      },
    },
    {
      method: "GET",
      pattern: "/api/campaigns/:id/spends",
      roles: ["buyer", "agent"],
      scope: "campaigns:read",
      handler: ({ db, actor, params }) => {
        getCampaign(db, actor!, params.id!);
        const rows = db
          .prepare(
            "SELECT * FROM spends WHERE campaign_id = ? ORDER BY created_at"
          )
          .all(params.id!) as unknown as SpendRow[];
        const receipts = db
          .prepare(
            `SELECT r.* FROM spend_receipts r
              JOIN spends s ON s.id = r.spend_id
             WHERE s.campaign_id = ?`
          )
          .all(params.id!) as unknown as {
          spend_id: string;
          tx_hash: string;
          raw: string;
          observed_at: string;
        }[];
        return {
          body: {
            spends: rows.map(spendView),
            receipts: receipts.map((r) => ({
              spendId: r.spend_id,
              txHash: r.tx_hash,
              receipt: JSON.parse(r.raw),
              observedAt: r.observed_at,
            })),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/health",
      public: true,
      handler: () => ({ body: { status: "ok", chain: app.chain.label } }),
    },
  ];
}

function numOr(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function quoteRequestView(q: QuoteRequestRow): Record<string, unknown> {
  return {
    id: q.id,
    campaignId: q.campaign_id,
    planItemId: q.plan_item_id,
    revisionId: q.revision_id,
    dimensions: q.dimensions,
    deadline: q.deadline,
    qty: q.qty,
    status: q.status,
    createdBy: q.created_by,
    createdAt: q.created_at,
  };
}

function campaignView(c: {
  id: string;
  tenant_id: string;
  name: string;
  budget_cap_atoms: number;
  budget_token: string;
  status: string;
  exception_note: string | null;
  created_at: string;
}): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    budgetCapAtoms: c.budget_cap_atoms,
    budgetToken: c.budget_token,
    status: c.status,
    exceptionNote: c.exception_note,
    createdAt: c.created_at,
  };
}
