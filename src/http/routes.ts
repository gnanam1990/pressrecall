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

export interface AppContext {
  objectDir: string;
}

export function buildRoutes(app: AppContext): Route[] {
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
      method: "GET",
      pattern: "/api/health",
      public: true,
      handler: () => ({ body: { status: "ok" } }),
    },
  ];
}

function numOr(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
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
