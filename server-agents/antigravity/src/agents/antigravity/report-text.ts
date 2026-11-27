import { isRecord } from '@garcon/common/json';
import { toolResultTextPart } from '@garcon/common/tool-result-content';
import type { TrackedCall } from './tool-call-snapshot.js';

type Block = Record<string, unknown>;

export function rawOutputText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  return isRecord(raw) && typeof raw.output === 'string' ? raw.output : '';
}

export function blockText(block: Block): string {
  return toolResultTextPart(block)?.text ?? '';
}

export function joinedReportText(blocks: readonly Block[]): string {
  return blocks.map(blockText).filter(Boolean).join('\n');
}

export interface TextEcho {
  readonly first: number;
  readonly last: number;
}

// Overlapping candidates can share almost the entire report. A prefix table avoids rechecking it at each block.
function* overlappingStarts(text: string, pattern: string): Generator<number> {
  const borders = new Uint32Array(pattern.length);
  for (let i = 1, n = 0; i < pattern.length; i++) {
    while (n && pattern[i] !== pattern[n]) n = borders[n - 1];
    if (pattern[i] === pattern[n]) n++;
    borders[i] = n;
  }
  for (let i = 0, n = 0; i < text.length; i++) {
    while (n && text[i] !== pattern[n]) n = borders[n - 1];
    if (text[i] === pattern[n]) n++;
    if (n === pattern.length) {
      yield i + 1 - n;
      n = borders[n - 1];
    }
  }
}

// A report can cross attachments. Only whole text blocks, apart from outer whitespace, can witness its text.
export function textEchoes(blocks: readonly Block[], output: string): TextEcho[] {
  if (!output) return [];
  const texts = blocks.map(blockText);
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  let offset = 0;
  for (const [i, text] of texts.entries()) {
    if (!text) continue;
    const end = text.trimEnd().length;
    if (end) {
      starts.set(offset + text.length - text.trimStart().length, i);
      ends.set(offset + end, i);
    }
    offset += text.length + 1;
  }
  const candidates = [...starts.keys()].filter(start => ends.has(start + output.length));
  if (!candidates.length) return [];
  const joined = texts.filter(Boolean).join('\n');
  const overlapping = candidates.some((start, i) => i > 0 && start < candidates[i - 1] + output.length);
  const occurrences = overlapping ? overlappingStarts(joined, output) : candidates.filter(start => joined.startsWith(output, start));
  const matches: TextEcho[] = [];
  for (const start of occurrences) {
    const first = starts.get(start);
    const last = ends.get(start + output.length);
    if (first !== undefined && last !== undefined) matches.push({ first, last });
  }
  return matches;
}

export function uniqueEcho(matches: readonly TextEcho[]): TextEcho | undefined {
  return matches.length === 1 ? matches[0] : undefined;
}

function independentIndices(blocks: readonly Block[], echoes: readonly TextEcho[]): number[] {
  const indices: number[] = [];
  let run = 0;
  for (const [index, block] of blocks.entries()) {
    while (run < echoes.length && echoes[run].last < index) run++;
    if (run < echoes.length && echoes[run].first <= index) continue;
    if (blockText(block).trim()) indices.push(index);
  }
  return indices;
}

function narrative(blocks: readonly Block[], echoes: readonly TextEcho[]): string {
  return independentIndices(blocks, echoes).map(i => blockText(blocks[i]).trim()).join('\n');
}

export function prefersReportContent(previous: TrackedCall | undefined, raw: unknown, blocks: TrackedCall['content']): boolean {
  const output = rawOutputText(raw).trim();
  if (output && output !== rawOutputText(previous?.rawOutput).trim()) return false;
  const wasNewer = previous?.reportContentIsNewer ?? false;
  if (!blocks || blocks === previous?.content) return wasNewer;
  const before = previous?.content ?? [];
  const oldEchoes = textEchoes(before, output);
  const newEchoes = textEchoes(blocks, output);
  const latest = narrative(blocks, newEchoes);
  const prior = narrative(before, oldEchoes);
  if (!latest || latest === prior) return wasNewer;
  // Formatting can change an exact match without changing the reported narrative.
  const previouslyEchoed = oldEchoes.length > 0;
  const nowEchoed = newEchoes.length > 0;
  if (previouslyEchoed !== nowEchoed && narrative(before, []) === narrative(blocks, [])) return wasNewer;
  if (nowEchoed && !previouslyEchoed && !prior) return wasNewer;
  return true;
}

export function primaryTextIndices(blocks: readonly Block[], echoes: readonly TextEcho[] = [], preferIndependent = false): number[] {
  if (preferIndependent) {
    const independent = independentIndices(blocks, echoes);
    if (independent.length || echoes.length > 1) return independent;
  }
  const match = uniqueEcho(echoes);
  const indices = blocks.flatMap((block, i) => blockText(block).trim() ? [i] : []);
  return match ? indices.filter(i => i >= match.first && i <= match.last) : indices;
}
