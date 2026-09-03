// Normalizes OpenCode tool results into the shared result-content shape the
// frontend display registry consumes. OpenCode tool state carries a plain-text
// output plus a tool-specific metadata record; glob and grep counts live only
// in that metadata, so without this pass every result renders as zero files.

import { normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';

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

function canonicalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function outputLines(state: Record<string, unknown>): string[] {
  if (Array.isArray(state.output)) {
    return state.output.map((line) => String(line).trim()).filter(Boolean);
  }
  const output = asString(state.output);
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// Glob emits one resolved path per line; the only non-path lines are the
// "No files found" sentinel and parenthesized truncation / limit notes.
function isGlobPathLine(line: string): boolean {
  return (
    line !== 'No files found'
    && !line.startsWith('(Results are truncated')
    && !line.startsWith('(Output capped')
    && !(line.startsWith('(') && line.endsWith(')'))
  );
}

// Grep groups matches under a non-indented "<path>:" heading; the remaining
// non-indented lines are the "Found N matches" header and truncation note.
function isGrepPathLine(line: string): boolean {
  return /^[^ \t].*:$/.test(line) && !(line.startsWith('(') && line.endsWith(')'));
}

function grepPathLine(line: string): string {
  return line.slice(0, -1);
}

function normalizeGlobResult(state: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(state.filenames)) {
    const filenames = state.filenames.filter((f): f is string => typeof f === 'string');
    return {
      filenames,
      numFiles: asNumber(state.numFiles ?? state.count) ?? filenames.length,
    };
  }
  const metadata = asObject(state.metadata);
  const filenames = outputLines(state).filter(isGlobPathLine);
  return {
    filenames,
    numFiles: asNumber(metadata.count) ?? filenames.length,
  };
}

function normalizeGrepResult(state: Record<string, unknown>): Record<string, unknown> {
  const metadata = asObject(state.metadata);
  const lines = outputLines(state);
  const filenames = Array.from(new Set(lines.filter(isGrepPathLine).map(grepPathLine)));
  let totalMatches = asNumber(metadata.matches);
  if (totalMatches === undefined) {
    const firstLine = lines[0] ?? '';
    const match = firstLine.match(/^Found\s+(\d+)\s+matches/i);
    totalMatches = match ? Number(match[1]) : undefined;
  }
  return {
    filenames,
    numFiles: filenames.length,
    totalMatches: totalMatches ?? 0,
  };
}

// Error results keep their raw text payload; only completed glob and grep
// outputs carry the count metadata this converter exists for.
export function normalizeOpenCodeToolResultContent(
  toolName: unknown,
  state: unknown,
): Record<string, unknown> {
  const rawState = typeof state === 'string'
    ? { output: state }
    : Array.isArray(state)
      ? { output: state.join('\n') }
      : asObject(state);
  const key = canonicalize(asString(toolName) ?? '');

  if (rawState.status !== 'error') {
    if (key === 'glob' || key === 'globtooluse') return normalizeGlobResult(rawState);
    if (key === 'grep' || key === 'greptooluse') return normalizeGrepResult(rawState);
  }
  return normalizeToolResultContent(rawState.output);
}
