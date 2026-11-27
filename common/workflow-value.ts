import { isRecord, stableJsonStringify } from './json.js';

export const WORKFLOW_VALUE_BYTES = 64 * 1024;
const encoder = new TextEncoder();
type Issue = 'invalid' | 'limit';

/** Checks bounds before sorting and serializing arbitrary launch or signal data. */
export function encodeWorkflowValue(value: unknown): { json: string } | { issue: Issue } {
  let nodes = 0;
  let characters = 0;
  const visit = (item: unknown, depth: number): Issue | undefined => {
    if (++nodes > 16_384 || depth > 32 || characters > WORKFLOW_VALUE_BYTES) return 'limit';
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (typeof item === 'string') {
      characters += item.length;
    } else if (Array.isArray(item)) {
      for (const element of item) {
        const issue = visit(element, depth + 1);
        if (issue) return issue;
      }
    } else if (isRecord(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      for (const key of Object.keys(item)) {
        characters += key.length;
        const issue = visit(item[key], depth + 1);
        if (issue) return issue;
      }
    } else return 'invalid';
    return characters > WORKFLOW_VALUE_BYTES ? 'limit' : undefined;
  };
  const issue = visit(value, 0);
  if (issue) return { issue };
  const json = stableJsonStringify(value);
  return json.length > WORKFLOW_VALUE_BYTES || encoder.encode(json).byteLength > WORKFLOW_VALUE_BYTES ? { issue: 'limit' } : { json };
}
