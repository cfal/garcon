import { isDeepStrictEqual } from 'node:util';
import { ToolResultMessage, type ToolUseChatMessage } from '@garcon/common/chat-types';
import { asObject, asString } from '@garcon/server-agent-common/acp/event-converter';
import {
  antigravityMcpArguments,
  antigravityToolName,
  antigravityToolResultText,
  type AntigravityToolCall,
} from './tool-use-converter.js';

export interface TrackedCall extends AntigravityToolCall {
  readonly rawOutput?: unknown;
  readonly content?: readonly Record<string, unknown>[];
  readonly contentIsNewer: boolean;
}

function isAgentWork(name: string | null): boolean {
  return name === 'manage_task' || name === 'update_steps' || name === 'send_message'
    || name === 'enter_plan_mode' || name === 'exit_plan_mode' || name === 'schedule';
}

function rawOutputText(raw: unknown): string {
  return asString(raw) ?? asString(asObject(raw).output) ?? '';
}

function isStructuredOutput(raw: unknown): boolean {
  if (raw == null || typeof raw === 'string') return false;
  if (typeof raw !== 'object' || Array.isArray(raw)) return true;
  return Object.entries(raw).some(([key, value]) => key !== 'output' || typeof value !== 'string');
}

function joinBlockText(blocks: readonly Record<string, unknown>[]): string {
  return blocks.map(block => asString(asObject(block.content).text)).filter(Boolean).join('\n');
}

function withoutOutputEchoes(blocks: readonly Record<string, unknown>[], output: string): readonly Record<string, unknown>[] {
  if (!output || !blocks.length) return blocks;
  const trimmed = output.trim();
  return blocks.filter(block => {
    const part = block.type === 'content' ? asObject(block.content) : block;
    if (part.type !== 'text') return true;
    const text = asString(part.text);
    if (text === output) return false;
    return trimmed === '' || text?.trim() !== trimmed;
  });
}

function prefersContent(previous: TrackedCall | undefined, rawOutput: unknown, content: TrackedCall['content']): boolean {
  if (rawOutput === previous?.rawOutput && content === previous?.content) return previous?.contentIsNewer ?? false;
  const output = rawOutputText(rawOutput);
  const outputChanged = output !== rawOutputText(previous?.rawOutput);
  if (content && content !== previous?.content) {
    const oldBlocks = previous?.content ?? [];
    const before = withoutOutputEchoes(oldBlocks, output);
    const after = withoutOutputEchoes(content, output);
    const hasOutputText = output.trim() !== '';
    // A newly echoed output confirms it alongside the other text on the frame.
    // Once confirmed, only a change to independent text can supersede it.
    if (hasOutputText && after.length < content.length && before.length === oldBlocks.length) return false;
    if (joinBlockText(before) !== joinBlockText(after)) return !(outputChanged && hasOutputText);
  }
  const rawChanged = outputChanged || (rawOutput !== previous?.rawOutput &&
    isStructuredOutput(rawOutput) && !isDeepStrictEqual(rawOutput, previous?.rawOutput));
  return !rawChanged && !!previous?.contentIsNewer;
}

function agentWorkResult(call: TrackedCall, status: string, terminal: Record<string, unknown>): ToolResultMessage['content'] {
  const output = rawOutputText(call.rawOutput);
  const blocks = withoutOutputEchoes(call.content ?? [], output);
  const blockText = joinBlockText(blocks);
  const trimmedOutput = output.trim();
  const trimmedBlocks = blockText.trim();
  const distinct = trimmedOutput !== '' && trimmedBlocks !== '' && trimmedOutput !== trimmedBlocks;
  const structured = isStructuredOutput(call.rawOutput);
  const name = antigravityToolName(call);
  const reportsPlanOrSchedule = name === 'schedule' || name === 'enter_plan_mode' || name === 'exit_plan_mode';
  // The terminal frame's text takes precedence even if it repeats an earlier frame.
  let primary: 'output' | 'metadata' | 'content';
  if (reportsPlanOrSchedule && rawOutputText(terminal.rawOutput).trim()) primary = 'output';
  else if (reportsPlanOrSchedule && Array.isArray(terminal.content) && trimmedBlocks) primary = 'content';
  else if (trimmedOutput && !(distinct && call.contentIsNewer)) primary = 'output';
  else if (structured && !trimmedOutput && !call.contentIsNewer) primary = 'metadata';
  else primary = 'content';

  const result: ToolResultMessage['content'] = status === 'completed' ? {} : { status };
  if (structured || (distinct && primary === 'content')) result.rawOutput = call.rawOutput;

  // Keeps separate progress and attachments, not a second copy of the primary text.
  const keepBlockText = primary === 'metadata' || (primary === 'output' && distinct);
  const items = keepBlockText ? blocks : blocks.filter(block => block.type !== 'content' || asObject(block.content).type !== 'text');
  if (items.length) result.items = items;
  if (primary === 'output' && !structured) result.raw = output;
  if (primary === 'content' && trimmedBlocks) result.raw = blockText;
  return result;
}

export function toolCallResult(timestamp: string, call: TrackedCall, terminal: Record<string, unknown>, status: string): ToolResultMessage {
  const name = call.isMcp ? null : antigravityToolName(call);
  if (isAgentWork(name)) {
    return new ToolResultMessage(timestamp, call.toolCallId, agentWorkResult(call, status, terminal), status !== 'completed');
  }

  // Other tools report text from the terminal frame, but a command's exit code can arrive earlier.
  const output = asString(asObject(terminal.rawOutput).output) ?? '';
  const blocks = Array.isArray(terminal.content) ? call.content ?? [] : [];
  const text = antigravityToolResultText(name ?? '', output.trim() ? output : joinBlockText(blocks));
  const exitCode = name === 'run_command' ? asObject(call.rawOutput).exit_code : undefined;
  const commandFailed = typeof exitCode === 'number' && exitCode !== 0;
  const content: ToolResultMessage['content'] = {};
  if (text.trim()) content.raw = text;
  else if (commandFailed) content.exitCode = exitCode;
  else if (status !== 'completed') content.status = status;
  return new ToolResultMessage(timestamp, call.toolCallId, content, commandFailed || status !== 'completed');
}

function acceptsPartialInput(name: string | null, input: Record<string, unknown>): boolean {
  return isAgentWork(name) || name === 'call_mcp_tool' || !!(asString(input.server) || asString(input.tool));
}

function mergeInput(previous: TrackedCall | undefined, call: AntigravityToolCall, name: string | null) {
  if (!previous) return call.input;
  if (!Object.keys(call.input).length) return previous.input;
  if (!previous.name || call.isMcp || previous.isMcp || acceptsPartialInput(name, previous.input)) {
    return { ...previous.input, ...call.input };
  }
  return call.input;
}

export function mergeCall(previous: TrackedCall | undefined, call: AntigravityToolCall, update?: Record<string, unknown>): TrackedCall {
  const name = call.name || previous?.name || null;
  const input = mergeInput(previous, call, name);
  // ACP patches rawOutput and content independently. A repeated snapshot does not
  // make its text newer. When both change together, rawOutput takes precedence.
  const rawOutput = update?.rawOutput ?? previous?.rawOutput;
  const content = Array.isArray(update?.content)
    ? update.content.map(asObject).filter(block => block.type !== 'diff') : previous?.content;
  return {
    ...call,
    name,
    kind: call.kind || previous?.kind || null,
    isMcp: call.isMcp || !!previous?.isMcp || !!(asString(input.server) && asString(input.tool)),
    planTitle: previous?.planTitle === 'excluded' ? 'excluded' : call.planTitle ?? previous?.planTitle ?? null,
    input,
    rawOutput,
    content,
    contentIsNewer: prefersContent(previous, rawOutput, content),
  };
}

export function needsMoreEvidence(call: TrackedCall, row: ToolUseChatMessage): boolean {
  if (!Object.keys(call.input).length) return true;
  if (row.type === 'mcp-tool-use') return !antigravityMcpArguments(call.input);
  // Schedule options and the other half of an MCP address can arrive on a later frame.
  if (call.isMcp || !call.name || call.name === 'schedule' || asString(call.input.server) || asString(call.input.tool)) return true;
  return row.type === 'external-tool-use' && acceptsPartialInput(call.name, call.input);
}
