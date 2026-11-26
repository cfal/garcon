import { isDeepStrictEqual } from 'node:util';
import { ToolResultMessage } from '@garcon/common/chat-types';
import { isRecord } from '@garcon/common/json';
import { plainToolResultTextPart, toolResultTextPart } from '@garcon/common/tool-result-content';
import type { TrackedCall } from './tool-call-snapshot.js';

type Block = Record<string, unknown>;
type Body = ToolResultMessage['content'];

function plainAcpText(block: Block): boolean {
  return block.type === 'content' && plainToolResultTextPart(block) !== null;
}

function plainText(block: Block): boolean {
  return plainToolResultTextPart(block) !== null;
}

function blockText(block: Block): string {
  return toolResultTextPart(block)?.text ?? '';
}

function planReportText(blocks: readonly Block[]): string {
  return blocks.map(blockText).filter(Boolean).join('\n');
}

interface TextEcho {
  readonly first: number;
  readonly last: number;
  readonly unique: boolean;
}

// A report can cross attachments. Only whole text blocks, apart from outer whitespace, can witness its text.
function findTextEcho(blocks: readonly Block[], output: string): TextEcho | undefined {
  if (!output) return undefined;
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
  const joined = texts.filter(Boolean).join('\n');
  let match: TextEcho | undefined;
  let occurrence = -1;
  for (const [start, first] of starts) {
    const last = ends.get(start + output.length);
    if (last === undefined) continue;
    if (start > occurrence) occurrence = joined.indexOf(output, start);
    if (occurrence < 0) break;
    if (start !== occurrence) continue;
    if (match) return { ...match, unique: false };
    match = { first, last, unique: true };
  }
  return match;
}

function withoutBlockText(block: Block): Block[] {
  const part = toolResultTextPart(block);
  if (!part) return [block];
  if (plainText(block)) return [];
  const metadata = { ...part, text: '' };
  return [part === block ? metadata : { ...block, content: metadata }];
}

function cachedBlocksForText(blocks: readonly Block[], output: string): Block[] {
  const echo = findTextEcho(blocks, output);
  return blocks.flatMap((block, i) =>
    echo?.unique && i >= echo.first && i <= echo.last ? [block] : withoutBlockText(block));
}

function overlayBlock(before: Block, after: Block): Block {
  const merged = { ...before, ...after };
  if (isRecord(before.annotations) && isRecord(after.annotations)) {
    merged.annotations = { ...before.annotations, ...after.annotations };
  }
  return merged;
}

function overlayText(before: Block, after: Block): Block {
  const oldPart = toolResultTextPart(before)!;
  const newPart = toolResultTextPart(after)!;
  const part = overlayBlock(oldPart, newPart);
  if (oldPart === before && newPart === after) return part;
  return { ...overlayBlock(before === oldPart ? {} : before, after === newPart ? {} : after), type: 'content', content: part };
}

// Only aligns one-to-one text blocks. Different segmentation does not establish annotation positions.
function alignTerminalBlocks(cached: readonly Block[], terminal: readonly Block[], echo: TextEcho): Block[] | undefined {
  const result: Block[] = [];
  let next = 0;
  for (const [i, block] of cached.entries()) {
    if (i < echo.first || i > echo.last) {
      if (toolResultTextPart(block)?.text === '' && isDeepStrictEqual(block, terminal[next])) result.push(terminal[next++]);
      else result.push(...withoutBlockText(block));
      continue;
    }
    const before = toolResultTextPart(block);
    if (!before?.text) {
      if (before && toolResultTextPart(terminal[next])?.text === '') result.push(overlayText(block, terminal[next++]));
      else if (!plainText(block)) result.push(block);
      continue;
    }
    const whitespace = !before.text.trim();
    while (next < terminal.length && (whitespace ? !blockText(terminal[next]) : !blockText(terminal[next]).trim())) result.push(terminal[next++]);
    const reported = terminal[next++];
    const after = toolResultTextPart(reported);
    if (!after || (whitespace ? after.text !== before.text : after.text.trim() !== before.text.trim())) return undefined;
    result.push(overlayText(block, reported));
  }
  for (; next < terminal.length; next++) {
    if (blockText(terminal[next]).trim()) return undefined;
    result.push(terminal[next]);
  }
  return result;
}

function reportBlocks(cached: readonly Block[], terminal: readonly Block[], terminalText: string, output: string): readonly Block[] {
  if (terminal.length && isDeepStrictEqual(cached, terminal)) return terminal;
  const terminalHasExtras = terminal.some(block => !plainText(block));
  if (terminalText) {
    if (cached.every(plainText) || terminal.some(block => !toolResultTextPart(block))) return terminal;
    const echo = findTextEcho(cached, terminalText);
    const aligned = echo?.unique ? alignTerminalBlocks(cached, terminal, echo) : undefined;
    return aligned ?? [...cached.flatMap(withoutBlockText), ...terminal];
  }
  const retained = output ? cachedBlocksForText(cached, output) : cached;
  if (!terminalHasExtras) return retained.length ? retained : terminal;
  // Only a supplied attachment list supersedes cached attachments, not annotations on text.
  const replacesAttachments = terminal.some(block => !toolResultTextPart(block));
  return [...(replacesAttachments ? retained.filter(block => toolResultTextPart(block)) : retained), ...terminal];
}

function rawText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  return isRecord(raw) && typeof raw.output === 'string' ? raw.output : '';
}

function metadata(raw: unknown): unknown {
  if (raw == null || typeof raw === 'string') return undefined;
  if (!isRecord(raw)) return raw;
  if (typeof raw.output !== 'string') return Object.keys(raw).length ? raw : undefined;
  const { output: _text, ...fields } = raw;
  return Object.keys(fields).length ? fields : undefined;
}

function reportMetadata(cached: unknown, terminal: unknown): unknown {
  const before = metadata(cached);
  const after = metadata(terminal);
  return isRecord(before) && isRecord(after) ? { ...before, ...after } : after ?? before;
}

function storeOutput(body: Body, raw: unknown, fields: unknown, alongsideBlocks: boolean): void {
  const text = rawText(raw);
  if (fields !== undefined) body.rawOutput = fields;
  if (!text.trim()) return;
  if (isRecord(fields) && !Object.hasOwn(fields, 'output')) body.rawOutput = { output: text, ...fields };
  else if (fields === undefined && alongsideBlocks) body.rawOutput = raw;
  else body.raw = text;
}

function independentIndices(blocks: readonly Block[], match: TextEcho | undefined, output: string): number[] {
  return blocks.flatMap((block, i) => {
    const text = blockText(block).trim();
    const echoed = match?.unique ? i >= match.first && i <= match.last : text === output;
    return text && !echoed ? [i] : [];
  });
}

export function prefersReportContent(previous: TrackedCall | undefined, raw: unknown, blocks: TrackedCall['content']): boolean {
  const output = rawText(raw).trim();
  if (output && output !== rawText(previous?.rawOutput).trim()) return false;
  const wasNewer = previous?.reportContentIsNewer ?? false;
  if (!blocks || blocks === previous?.content) return wasNewer;
  const before = previous?.content ?? [];
  const oldEcho = findTextEcho(before, output);
  const newEcho = findTextEcho(blocks, output);
  if (newEcho && !oldEcho) return false;
  const narrative = (items: readonly Block[], match: TextEcho | undefined) =>
    independentIndices(items, match, output).map(i => blockText(items[i]).trim()).join('\n');
  const newest = narrative(blocks, newEcho);
  return newest && newest !== narrative(before, oldEcho) ? true : wasNewer;
}

function primaryBlocks(blocks: readonly Block[], match?: TextEcho, output = '', preferIndependent = false): number[] {
  if (preferIndependent) {
    const independent = independentIndices(blocks, match, output);
    if (independent.length) return independent;
  }
  const indices = blocks.flatMap((block, i) => blockText(block).trim() ? [i] : []);
  return match?.unique ? indices.filter(i => i >= match.first && i <= match.last) : indices;
}

export function planOrScheduleResult(
  timestamp: string, call: TrackedCall, previous: TrackedCall | undefined, terminal: Record<string, unknown>, status: string,
): ToolResultMessage {
  const frame = Array.isArray(terminal.content) ? call.content ?? [] : [];
  const frameText = planReportText(frame).trim();
  const frameOutput = rawText(terminal.rawOutput).trim();
  const cachedOutput = previous?.rawOutput;
  const raw = frameOutput ? terminal.rawOutput : cachedOutput;
  const output = rawText(raw).trim();
  const fields = reportMetadata(cachedOutput, terminal.rawOutput);
  const blocks = reportBlocks(previous?.content ?? [], frame, frameText, frameOutput);
  const match = findTextEcho(blocks, output);
  const echo = match?.unique ? match : undefined;
  const text = planReportText(blocks);
  const newerCachedText = previous?.reportContentIsNewer ?? false;
  const terminalPrefersBlocks = !!frameText && call.reportContentIsNewer && (!frameOutput || frameOutput === rawText(cachedOutput).trim());
  const specificEcho = echo !== undefined && text.trim() !== output;
  const preferCachedBlocks = !frameText && !frameOutput && newerCachedText;
  const preferIndependent = preferCachedBlocks || terminalPrefersBlocks;
  const rankCachedText = !frameText && !frameOutput && (output ? preferCachedBlocks : fields !== undefined);
  const body: Body = status === 'completed' ? {} : { status };
  let primary: number[] = [];
  if (specificEcho || (match && !echo && preferIndependent) || (terminalPrefersBlocks && frameOutput) || blocks.some(block => !plainAcpText(block))) {
    body.items = blocks;
    storeOutput(body, echo || (frameText && !frameOutput) ? undefined : raw, fields, true);
    if (echo || (frameText && !frameOutput) || terminalPrefersBlocks || rankCachedText) {
      primary = primaryBlocks(blocks, match, output, preferIndependent);
    }
  } else if (frameOutput || (!frameText && output && !preferCachedBlocks)) {
    storeOutput(body, raw, fields, false);
    if (!echo && text.trim()) body.items = blocks;
  } else {
    const keepCachedOutput = !frameText && output && !echo;
    storeOutput(body, keepCachedOutput ? raw : undefined, fields, true);
    if (text.trim()) {
      if (body.raw !== undefined || (!frameText && !output && fields !== undefined && (!preferCachedBlocks || metadata(terminal.rawOutput) !== undefined))) {
        body.items = blocks;
        primary = primaryBlocks(blocks);
      }
      else body.raw = text;
    }
  }
  return new ToolResultMessage(timestamp, call.toolCallId, body, status !== 'completed', primary.length ? primary : undefined);
}
