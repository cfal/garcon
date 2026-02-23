// Shared normalization helpers for chat message conversion.

// Normalizes raw tool input into a plain object to match the
// ToolUseMessage.toolInput shape. Handles objects, JSON strings, and
// fallback cases for historical data stored in various formats.
export function normalizeToolInput(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return { raw: value };
    } catch {
      return { raw: value };
    }
  }
  return {};
}

// Normalizes raw tool result content into a plain object to match
// ToolResultMessage.content. Handles strings, arrays (Claude SDK content
// blocks), objects, and null.
export function normalizeToolResultContent(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return { items: value };
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed)) return { items: parsed };
      return { raw: value };
    } catch {
      return { raw: value };
    }
  }
  return {};
}
