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

function joinedText(blocks: readonly Block[]): string {
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

function cachedBlocksForText(blocks: readonly Block[], output: string): Block[] {
  const echo = findTextEcho(blocks, output);
  return blocks.flatMap((block, i) => {
    const part = toolResultTextPart(block);
    if (!part || (echo?.unique && i >= echo.first && i <= echo.last)) return [block];
    if (plainText(block)) return [];
    // Retains block annotations without presenting their superseded text.
    const metadata = { ...part, text: '' };
    return [part === block ? metadata : { ...block, content: metadata }];
  });
}

function reportBlocks(cached: readonly Block[], terminal: readonly Block[], terminalText: string, output: string): readonly Block[] {
  const terminalHasExtras = terminal.some(block => !plainText(block));
  if (terminalText) {
    if (terminalHasExtras || cached.every(plainText)) return terminal;
    const retained = cachedBlocksForText(cached, terminalText);
    if (joinedText(retained) === joinedText(terminal)) return retained;
    return [...cachedBlocksForText(cached, ''), ...terminal];
  }
  const retained = output ? cachedBlocksForText(cached, output) : cached;
  if (!terminalHasExtras) return retained.length ? retained : terminal;
  // A terminal attachment list is ordered by the provider; only absent text falls back.
  return [...retained.filter(block => blockText(block).trim()), ...terminal];
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

export function planOrScheduleResult(
  timestamp: string, call: TrackedCall, previous: TrackedCall | undefined, terminal: Record<string, unknown>, status: string,
): ToolResultMessage {
  const frame = Array.isArray(terminal.content) ? call.content ?? [] : [];
  const frameText = joinedText(frame).trim();
  const frameOutput = rawText(terminal.rawOutput).trim();
  const cachedOutput = previous?.rawOutput;
  const raw = frameOutput ? terminal.rawOutput : cachedOutput;
  const output = rawText(raw).trim();
  const fields = reportMetadata(cachedOutput, terminal.rawOutput);
  const blocks = reportBlocks(previous?.content ?? [], frame, frameText, frameOutput);
  const echo = findTextEcho(blocks, output);
  const text = joinedText(blocks);
  const repeatedOutputWithNewText = frameOutput !== '' && frameText !== '' && !echo
    && frameOutput === rawText(cachedOutput).trim() && frameText !== joinedText(previous?.content ?? []).trim();
  const specificEcho = echo !== undefined && text.trim() !== output;
  const body: Body = status === 'completed' ? {} : { status };
  let primary: number[] = [];
  if (specificEcho || repeatedOutputWithNewText || blocks.some(block => !plainAcpText(block))) {
    body.items = blocks;
    storeOutput(body, echo || (frameText && !frameOutput) ? undefined : raw, fields, true);
    if (echo || (frameText && !frameOutput) || repeatedOutputWithNewText) {
      primary = blocks.flatMap((block, i) =>
        (!echo || (i >= echo.first && i <= echo.last)) && blockText(block).trim() ? [i] : []);
    }
  } else if (frameOutput || (!frameText && output && !call.contentIsNewer)) {
    storeOutput(body, raw, fields, false);
    if (!echo && text.trim()) body.items = blocks;
  } else {
    const keepCachedOutput = !frameText && output && !echo;
    storeOutput(body, keepCachedOutput ? raw : undefined, fields, true);
    if (text.trim()) {
      if (!frameText && !output && fields !== undefined && !call.contentIsNewer) body.items = blocks;
      else body.raw = text;
    }
  }
  return new ToolResultMessage(timestamp, call.toolCallId, body, status !== 'completed', primary.length ? primary : undefined);
}
