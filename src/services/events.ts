import type { Db } from "../db/connection.js";
import { nowIso } from "../domain/ids.js";
import { canonicalize } from "../domain/canon.js";

export interface EventInput {
  type: string;
  campaignId?: string | undefined;
  actorId?: string | undefined;
  entityType: string;
  entityId: string;
  payload?: unknown;
}

/**
 * Append-only structured transition log. `seq` is the monotonic server
 * sequence. Operational log — kept separate from shareable evidence exports.
 */
export function emit(db: Db, e: EventInput): number {
  const r = db
    .prepare(
      `INSERT INTO events (type, campaign_id, actor_id, entity_type, entity_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.type,
      e.campaignId ?? null,
      e.actorId ?? null,
      e.entityType,
      e.entityId,
      canonicalize(e.payload ?? {}),
      nowIso()
    );
  return Number(r.lastInsertRowid);
}
