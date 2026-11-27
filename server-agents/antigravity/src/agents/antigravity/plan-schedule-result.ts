import { isDeepStrictEqual } from 'node:util';
import { ToolResultMessage } from '@garcon/common/chat-types';
import { isRecord } from '@garcon/common/json';
import { plainToolResultTextPart, toolResultTextPart } from '@garcon/common/tool-result-content';
import { blockText, independentTextIndices, joinedReportText, primaryTextIndices, rawOutputText, textEchoes, uniqueEcho, type TextEcho } from './report-text.js';
import type { TrackedCall } from './tool-call-snapshot.js';

type Block = Record<string, unknown>;
type Body = ToolResultMessage['content'];

function plainText(block: Block): boolean {
  return plainToolResultTextPart(block) !== null;
}

function withoutBlockText(block: Block): Block[] {
  const part = toolResultTextPart(block);
  if (!part) return [block];
  if (plainText(block)) return [];
  const metadata = { ...part, text: '' };
  return [part === block ? metadata : { ...block, content: metadata }];
}

function cachedBlocksForText(blocks: readonly Block[], output: string): Block[] {
  const echo = uniqueEcho(textEchoes(blocks, output));
  return blocks.flatMap((block, i) =>
    echo && i >= echo.first && i <= echo.last ? [block] : withoutBlockText(block));
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
    // Interior whitespace is part of a multi-block echo; only its outer edges may be trimmed.
    const comparable = before.text.trim() ? (text: string) => text.trim() : (text: string) => text;
    while (next < terminal.length && !comparable(blockText(terminal[next]))) result.push(terminal[next++]);
    const reported = terminal[next++];
    const after = toolResultTextPart(reported);
    if (!after || comparable(after.text) !== comparable(before.text)) return undefined;
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
  // A supplied attachment list replaces the old one, but not annotations on retained text.
  if (terminal.some(block => !toolResultTextPart(block))) cached = cached.filter(block => toolResultTextPart(block));
  if (terminalText) {
    if (cached.every(plainText)) return terminal;
    const echo = uniqueEcho(textEchoes(cached, terminalText));
    const aligned = echo ? alignTerminalBlocks(cached, terminal, echo) : undefined;
    return aligned ?? [...cached.flatMap(withoutBlockText), ...terminal];
  }
  const retained = output ? cachedBlocksForText(cached, output) : cached;
  if (terminal.every(plainText)) return retained.length ? retained : terminal;
  return [...retained, ...terminal];
}

function metadata(raw: unknown): unknown {
  if (raw == null || typeof raw === 'string') return undefined;
  if (!isRecord(raw)) return raw;
  if (typeof raw.output !== 'string') return Object.keys(raw).length ? raw : undefined;
  const { output: _text, ...fields } = raw;
  return Object.keys(fields).length ? fields : undefined;
}

function mergeMetadata(cached: unknown, terminal: unknown): unknown {
  return isRecord(cached) && isRecord(terminal) ? { ...cached, ...terminal } : terminal ?? cached;
}

function storeOutput(body: Body, raw: unknown, fields: unknown, placement: 'standalone' | 'with-blocks'): void {
  const text = rawOutputText(raw);
  if (fields !== undefined) body.rawOutput = fields;
  if (!text.trim()) return;
  if (isRecord(fields) && !Object.hasOwn(fields, 'output')) body.rawOutput = { output: text, ...fields };
  else if (fields === undefined && placement === 'with-blocks') body.rawOutput = raw;
  else body.raw = text;
}

export function planOrScheduleResult(
  timestamp: string, call: TrackedCall, previous: TrackedCall | undefined, terminal: Record<string, unknown>, status: string,
): ToolResultMessage {
  const frame = Array.isArray(terminal.content) ? call.content ?? [] : [];
  const frameText = joinedReportText(frame).trim();
  const frameOutput = rawOutputText(terminal.rawOutput).trim();
  const cachedOutput = previous?.rawOutput;
  const raw = frameOutput ? terminal.rawOutput : cachedOutput;
  const output = frameOutput || rawOutputText(cachedOutput).trim();
  const terminalMetadata = metadata(terminal.rawOutput);
  const fields = mergeMetadata(metadata(cachedOutput), terminalMetadata);
  const blocks = reportBlocks(previous?.content ?? [], frame, frameText, frameOutput);
  const echoes = textEchoes(blocks, output);
  const echo = uniqueEcho(echoes);
  const text = joinedReportText(blocks);
  const useCache = !frameText && !frameOutput;
  const blocksOnly = !!frameText && !frameOutput;
  // A changed, nonblank output already wins over simultaneous content in prefersReportContent.
  const preferBlocks = useCache ? previous?.reportContentIsNewer === true : !!frameText && call.reportContentIsNewer;
  const separateOutput = !echo && !blocksOnly && !!output;
  const keepOrderedBlocks = (echo && text.trim() !== output)
    || (preferBlocks && (echoes.length > 1 || frameOutput))
    || blocks.some(block => block.type !== 'content' || !plainText(block));
  const body: Body = status === 'completed' ? {} : { status };
  let primary: number[] = [];
  if (keepOrderedBlocks) {
    body.items = blocks;
    storeOutput(body, separateOutput ? raw : undefined, fields, 'with-blocks');
    if (preferBlocks) primary = independentTextIndices(blocks, echoes);
    if (!primary.length && !separateOutput) primary = primaryTextIndices(blocks, echo);
  } else if (frameOutput || (useCache && output && !preferBlocks)) {
    storeOutput(body, raw, fields, 'standalone');
    if (!echo && text.trim()) body.items = blocks;
  } else {
    const keepCachedOutput = useCache && output && !echo;
    storeOutput(body, keepCachedOutput ? raw : undefined, fields, 'with-blocks');
    if (text.trim()) {
      const metadataIsPrimary = useCache && !output && fields !== undefined && (!preferBlocks || terminalMetadata !== undefined);
      if (body.raw !== undefined || metadataIsPrimary) {
        body.items = blocks;
        primary = primaryTextIndices(blocks);
      } else {
        body.raw = text;
      }
    }
  }
  return new ToolResultMessage(timestamp, call.toolCallId, body, status !== 'completed', primary.length ? primary : undefined);
}
