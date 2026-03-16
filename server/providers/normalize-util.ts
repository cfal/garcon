// Normalizes provider payloads into the canonical chat contract.

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
