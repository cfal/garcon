import { normalizeToolResultContent } from '../normalize-util.js';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function canonicalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function highLevelSuccess(value: unknown): Record<string, unknown> {
  const highLevel = asObject(value);
  return asObject(asObject(highLevel.output).success);
}

function normalizeSearchResultFromSuccess(success: Record<string, unknown>): Record<string, unknown> | null {
  const filenames = asStringArray(success.files ?? success.filenames ?? success.paths);
  const numFiles = asNumber(success.totalFiles ?? success.numFiles ?? success.total ?? success.count);
  if (!filenames && numFiles === undefined) return null;
  return {
    filenames: filenames ?? [],
    numFiles: numFiles ?? filenames?.length ?? 0,
  };
}

function normalizeSearchResultFromText(raw: string): Record<string, unknown> | null {
  const filenames = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
  const totalMatch = raw.match(/\btotal\s+(\d+)\s+files?\b/i);
  const numFiles = totalMatch ? Number(totalMatch[1]) : undefined;
  if (filenames.length === 0 && numFiles === undefined) return null;
  return {
    filenames,
    numFiles: Number.isFinite(numFiles) ? numFiles : filenames.length,
  };
}

function normalizeReadResultFromSuccess(success: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.keys(success).length === 0) return null;
  return {
    content: success.content,
    path: success.path,
    totalLines: success.totalLines,
    fileSize: success.fileSize,
    readRange: success.readRange,
  };
}

export function normalizeCursorToolResultContent(
  toolName: unknown,
  rawContent: unknown,
  highLevelToolCallResult?: unknown,
): Record<string, unknown> {
  const key = canonicalize(asString(toolName) ?? '');
  const success = highLevelSuccess(highLevelToolCallResult);

  if (key === 'glob' || key === 'grep' || key === 'search' || key === 'searchfiles') {
    const structured = normalizeSearchResultFromSuccess(success);
    if (structured) return structured;

    const normalized = normalizeToolResultContent(rawContent);
    const raw = asString(normalized.raw);
    if (raw) {
      const parsed = normalizeSearchResultFromText(raw);
      if (parsed) return parsed;
    }
    return normalized;
  }

  if (key === 'read') {
    const structured = normalizeReadResultFromSuccess(success);
    if (structured) return structured;
  }

  return normalizeToolResultContent(rawContent);
}
