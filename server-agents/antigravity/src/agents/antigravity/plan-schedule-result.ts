import { ToolResultMessage } from '@garcon/common/chat-types';
import { isRecord } from '@garcon/common/json';
import { isPlainTextPart, toolResultTextPart } from '@garcon/common/tool-result-content';
import type { TrackedCall } from './tool-call-snapshot.js';

type Block = Record<string, unknown>;
type Body = ToolResultMessage['content'];

function plainText(block: Block): boolean {
  return isPlainTextPart(block) ||
    (block.type === 'content' && Object.keys(block).length === 2 && isPlainTextPart(block.content));
}

function blockText(block: Block): string {
  return toolResultTextPart(block)?.text ?? '';
}

function joinedText(blocks: readonly Block[]): string {
  return blocks.map(blockText).filter(Boolean).join('\n');
}

// An output spanning text blocks can cross images, but cannot start or end inside a block.
function echoIndices(blocks: readonly Block[], output: string): number[] {
  if (!output) return [];
  const texts = blocks.map(blockText);
  const joined = texts.filter(Boolean).join('\n');
  if (joined.trim() === output) return texts.flatMap((text, i) => text ? [i] : []);
  const single = texts.flatMap((text, i) => text.trim() === output ? [i] : []);
  if (!output.includes('\n')) return single.length === 1 ? single : [];
  const start = joined.indexOf(output);
  if (start < 0 || start !== joined.lastIndexOf(output)) return [];
  const end = start + output.length;
  const indices: number[] = [];
  let offset = 0;
  for (const [i, text] of texts.entries()) {
    if (!text) continue;
    if (offset === start || indices.length) {
      indices.push(i);
      if (offset + text.length === end) return indices;
    }
    offset += text.length + 1;
    if (offset > end) break;
  }
  return [];
}

function cachedBlocksForText(blocks: readonly Block[], output: string): Block[] {
  const echoes = new Set(echoIndices(blocks, output));
  return blocks.flatMap((block, i) => {
    const part = toolResultTextPart(block);
    if (!part || echoes.has(i)) return [block];
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
  const echoes = echoIndices(blocks, output);
  const text = joinedText(blocks);
  const body: Body = status === 'completed' ? {} : { status };
  let primary: number[] = [];
  if (blocks.some(block => !plainText(block))) {
    body.items = blocks;
    storeOutput(body, echoes.length || (frameText && !frameOutput) ? undefined : raw, fields, true);
    if (frameText && !frameOutput) primary = blocks.flatMap((block, i) => blockText(block).trim() ? [i] : []);
    else primary = echoes.filter(i => blockText(blocks[i]).trim());
  } else if (frameOutput || (!frameText && output && !call.contentIsNewer)) {
    storeOutput(body, raw, fields, false);
    const echoed = new Set(echoes);
    const other = blocks.filter((block, i) => !echoed.has(i) && blockText(block).trim());
    if (other.length) body.items = other;
  } else {
    const keepCachedOutput = !frameText && output && !echoes.length;
    storeOutput(body, keepCachedOutput ? raw : undefined, fields, true);
    if (text.trim()) {
      if (!frameText && !output && fields !== undefined && !call.contentIsNewer) body.items = blocks;
      else body.raw = text;
    }
  }
  return new ToolResultMessage(timestamp, call.toolCallId, body, status !== 'completed', primary.length ? primary : undefined);
}
