// Oracle for server-agents/common/src/acp/event-converter.ts: its functions on
// plain JSON, and the eviction on a set or a map described by its entries.
import {
  acpContentText,
  asObject,
  asString,
  evictOldestToolEntry,
} from "../../../../server-agents/common/src/acp/event-converter.ts";

export { acpContentText, asObject, asString };

// A string list is a set of tool ids; a list of pairs is a map keyed by them.
export function evictOldest(entries: unknown): unknown[] {
  const pairs = Array.isArray(entries) && entries.length > 0 && Array.isArray(entries[0]);
  const collection = pairs
    ? new Map(entries as [string, unknown][])
    : new Set(entries as string[]);
  evictOldestToolEntry(collection as Set<string> & Map<string, unknown>);
  return [...collection.keys()];
}
