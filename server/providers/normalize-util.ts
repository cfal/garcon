// Normalizes provider payloads into the canonical chat contract.

import type { TodoItem, TodoStatus } from '../../common/chat-types.js';

// Coerces a provider-specific status value to the canonical TodoStatus.
// Handles Codex's boolean `completed` and string variants like 'done'.
function coerceStatus(raw: unknown, completed?: unknown): TodoStatus {
  if (completed === true || raw === 'completed' || raw === 'done') return 'completed';
  if (raw === 'in_progress' || raw === 'in-progress') return 'in_progress';
  return 'pending';
}

// Normalizes a provider-specific todo/plan list into canonical TodoItem[].
// Accepts shapes from Claude ({content, status}), Codex live ({text, completed}),
// and Codex JSONL/update_plan ({step, status}).
export function normalizeTodoItems(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const content = obj.content ?? obj.text ?? obj.step;
    if (typeof content !== 'string') continue;
    items.push({ content, status: coerceStatus(obj.status, obj.completed) });
  }
  return items.length > 0 ? items : undefined;
}

export function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      return { raw: value };
    } catch {
      return { raw: value };
    }
  }
  return {};
}

export function normalizeToolResultContent(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (Array.isArray(value)) return { items: value };
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      if (Array.isArray(parsed)) return { items: parsed };
      return { raw: value };
    } catch {
      return { raw: value };
    }
  }
  return {};
}
