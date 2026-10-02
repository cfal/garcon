import type { WindowReorderValidation } from './types.js';

export function dedup(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function findWindowIndex(full: string[], windowIds: string[]): number {
  if (windowIds.length === 0 || windowIds.length > full.length) return -1;
  for (let i = 0; i <= full.length - windowIds.length; i += 1) {
    let ok = true;
    for (let j = 0; j < windowIds.length; j += 1) {
      if (full[i + j] !== windowIds[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

export function applyWindowReorder(full: string[], oldOrder: string[], newOrder: string[]): string[] | null {
  const at = findWindowIndex(full, oldOrder);
  if (at < 0) return null;
  return [...full.slice(0, at), ...newOrder, ...full.slice(at + oldOrder.length)];
}

export function validateWindowReorder(rawOldOrder: unknown, rawNewOrder: unknown): WindowReorderValidation {
  const oldOrder = dedup(rawOldOrder);
  const newOrder = dedup(rawNewOrder);

  if (oldOrder.length === 0) {
    return { success: false, error: 'oldOrder must not be empty', errorCode: 'ORDER_INVALID_INPUT', status: 400 };
  }
  if (oldOrder.length !== newOrder.length) {
    return {
      success: false,
      error: 'oldOrder and newOrder must have the same length',
      errorCode: 'ORDER_INVALID_INPUT',
      status: 400,
    };
  }

  const oldSet = new Set(oldOrder);
  const newSet = new Set(newOrder);
  if (oldOrder.length !== oldSet.size || newOrder.length !== newSet.size) {
    return {
      success: false,
      error: 'oldOrder and newOrder must contain unique IDs',
      errorCode: 'ORDER_INVALID_INPUT',
      status: 400,
    };
  }
  for (const id of newOrder) {
    if (!oldSet.has(id)) {
      return {
        success: false,
        error: 'oldOrder and newOrder must contain the same IDs',
        errorCode: 'ORDER_INVALID_INPUT',
        status: 400,
      };
    }
  }

  return { success: true, oldOrder, newOrder };
}
