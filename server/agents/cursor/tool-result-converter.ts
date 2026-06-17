import { normalizeToolResultContent } from '../shared/normalize-util.js';

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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
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

function rawSuccess(value: unknown): Record<string, unknown> {
  return asObject(asObject(value).success);
}

function firstObject(...values: Record<string, unknown>[]): Record<string, unknown> {
  return values.find((value) => Object.keys(value).length > 0) ?? {};
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

function normalizeGrepWorkspaceResultFromSuccess(success: Record<string, unknown>): Record<string, unknown> | null {
  const workspaceResults = asObject(success.workspaceResults);
  if (Object.keys(workspaceResults).length === 0) return null;

  const filenames = new Set<string>();
  const matches: Array<{
    file: string;
    matches: Array<{
      lineNumber?: number;
      content?: string;
      contentTruncated?: boolean;
      isContextLine?: boolean;
    }>;
  }> = [];
  let totalMatches = 0;
  let sawTotalMatches = false;
  let truncated = false;

  for (const workspaceResult of Object.values(workspaceResults)) {
    const content = asObject(asObject(workspaceResult).content);
    const totalMatchedLines = asNumber(content.totalMatchedLines ?? content.totalLines);
    if (totalMatchedLines !== undefined) {
      totalMatches += totalMatchedLines;
      sawTotalMatches = true;
    }

    truncated = truncated
      || asBoolean(content.clientTruncated) === true
      || asBoolean(content.ripgrepTruncated) === true;

    const rawMatches = Array.isArray(content.matches) ? content.matches : [];
    for (const rawFileMatch of rawMatches) {
      const fileMatch = asObject(rawFileMatch);
      const file = asString(fileMatch.file);
      if (!file) continue;
      filenames.add(file);

      const lineMatches = (Array.isArray(fileMatch.matches) ? fileMatch.matches : [])
        .map((rawLineMatch) => {
          const lineMatch = asObject(rawLineMatch);
          return {
            lineNumber: asNumber(lineMatch.lineNumber),
            content: asString(lineMatch.content),
            contentTruncated: asBoolean(lineMatch.contentTruncated),
            isContextLine: asBoolean(lineMatch.isContextLine),
          };
        })
        .filter((lineMatch) =>
          lineMatch.lineNumber !== undefined
          || lineMatch.content !== undefined
          || lineMatch.contentTruncated !== undefined
          || lineMatch.isContextLine !== undefined);

      if (!sawTotalMatches) totalMatches += lineMatches.length;
      matches.push({ file, matches: lineMatches });
    }
  }

  if (filenames.size === 0 && totalMatches === 0) return null;

  return {
    filenames: Array.from(filenames),
    numFiles: filenames.size,
    totalMatches,
    matches,
    ...(asString(success.pattern) ? { pattern: asString(success.pattern) } : {}),
    ...(asString(success.path) ? { path: asString(success.path) } : {}),
    ...(truncated ? { truncated } : {}),
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
  const success = firstObject(highLevelSuccess(highLevelToolCallResult), rawSuccess(rawContent));

  if (key === 'glob' || key === 'grep' || key === 'search' || key === 'searchfiles') {
    const grepWorkspaceResult = normalizeGrepWorkspaceResultFromSuccess(success);
    if (grepWorkspaceResult) return grepWorkspaceResult;

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
