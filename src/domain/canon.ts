import { createHash } from "node:crypto";

/**
 * Canonical serialization: UTF-8 JSON with recursively sorted object keys,
 * no insignificant whitespace. Arrays keep order. Used for all content
 * addressing (asset digests, quote hashes, proof hashes, intent digests).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256hex(canonicalize(value));
}
